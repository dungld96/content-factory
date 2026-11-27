import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  renderJobInputSchema,
  renderManifestSchema,
  renderSettingsSchema,
  type RenderManifest,
  type RenderSettings,
} from '@acf/content-domain';
import type { GenerationJob, Prisma, PrismaClient } from '@acf/database';
import {
  DEFAULT_MEDIA_TOOLS,
  DEFAULT_RENDER_SPEC,
  ffmpegVersion,
  inspectRender,
  MediaToolsMissingError,
  RenderInputError,
  renderThumbnail,
  renderVideo,
  sha256File,
  type MediaTools,
  type QcReport,
  type RenderOutputSpec,
  type RenderAudioMix,
} from '@acf/media';
import { assetObjectKey, uuidv7, type ObjectStore, type StoredMimeType } from '@acf/storage';

import type { JobStore } from './job-store.js';
import type { Logger } from './logger.js';
import { MediaDiscardedError, MediaPermanentError } from './media-jobs.js';

export interface RenderJobsDeps {
  readonly prisma: PrismaClient;
  readonly jobs: JobStore;
  readonly store: ObjectStore | null;
  readonly tools?: MediaTools | undefined;
  /** Ceiling per FFmpeg step (`RENDER_TIMEOUT_MS`). */
  readonly stepTimeoutMs?: number | undefined;
  readonly logger: Logger;
}

/** Largest input file read for a render (clips ≤ 200 MB, M5). */
const MAX_INPUT_BYTES = 250 * 1024 * 1024;

/** The output spec of the frozen settings, for the media pipeline. */
function specOf(settings: RenderSettings): RenderOutputSpec {
  return {
    ...DEFAULT_RENDER_SPEC,
    width: settings.output.width,
    height: settings.output.height,
    fps: settings.output.fps,
    crf: settings.output.crf,
    audioBitrate: settings.output.audioBitrate,
    sampleRate: settings.output.sampleRate,
    loudness: settings.loudness,
  };
}

/**
 * Render jobs (M6 design §3–§8): download the frozen inputs, assemble with FFmpeg, run QC, store
 * the outputs write-once and record them on the render — outputs, lineage and the job's success in
 * one transaction. A failed QC is final (same inputs, same result); infrastructure errors retry.
 */
export class RenderJobs {
  constructor(private readonly deps: RenderJobsDeps) {}

  async run(job: GenerationJob): Promise<string> {
    const { prisma, jobs, logger } = this.deps;
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    const tools = this.deps.tools ?? DEFAULT_MEDIA_TOOLS;
    const { renderId } = renderJobInputSchema.parse(job.input);
    const render = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
    const manifest = renderManifestSchema.parse(render.manifest);
    const settings = renderSettingsSchema.parse(render.settings);
    const spec = specOf(settings);

    const dir = await mkdtemp(path.join(tmpdir(), 'acf-render-'));
    try {
      const files = await this.download(job.projectId, manifest, dir, store);
      const started = Date.now();
      let out;
      try {
        out = await renderVideo({
          workDir: dir,
          spec,
          tools,
          stepTimeoutMs: this.deps.stepTimeoutMs,
          burnInCaptions: settings.captions.burnIn,
          music: manifest.music
            ? { file: files.get(manifest.music.assetId) ?? '', volumeDb: manifest.music.volumeDb }
            : null,
          audio: audioMix(manifest, files),
          scenes: manifest.scenes.map((s) => ({
            durationMs: s.durationMs,
            clipFile: files.get(s.clipAssetId) ?? '',
            clipDurationMs: s.clipDurationMs,
            voiceFile: s.voiceoverAssetId ? (files.get(s.voiceoverAssetId) ?? null) : null,
            voiceDurationMs: s.voiceoverDurationMs,
            text: s.text,
            ...(manifest.audio
              ? {
                  clipHasAudio: s.clipHasAudio ?? false,
                  voiceOffsetMs:
                    manifest.audio.scenes.find((x) => x.sceneNumber === s.sceneNumber)
                      ?.voiceOffsetMs ?? 0,
                }
              : {}),
          })),
          onStage: (stage) => jobs.recordProgress(job, stage),
        });
      } catch (error) {
        if (error instanceof RenderInputError)
          throw new MediaPermanentError('RENDER_INPUT_INVALID', error.message);
        if (error instanceof MediaToolsMissingError) {
          throw new MediaPermanentError(
            'MEDIA_TOOLS_MISSING',
            'FFmpeg is not installed on the worker',
          );
        }
        throw error;
      }
      const qc = await inspectRender(
        out.videoFile,
        {
          spec,
          durationMs: out.durationMs,
          sceneStartsMs: out.sceneStartsMs,
          heldFrames: out.heldFrames,
          speechWindows: out.speechWindows,
        },
        tools,
      );
      const report = {
        ...qc,
        loudnessInput: out.loudness,
        ffmpeg: await ffmpegVersion(tools),
        elapsedMs: Date.now() - started,
      };
      if (!qc.passed) {
        // Keep the report for the reviewer, then fail: rendering again would give the same result.
        if (render.qc === null) {
          await prisma.render.update({ where: { id: render.id }, data: { qc: toJson(report) } });
        }
        throw new MediaPermanentError('RENDER_QC_FAILED', qcSummary(qc));
      }

      const thumbnail = path.join(dir, 'thumbnail.jpg');
      const keyframe = manifest.scenes[0]?.keyframeAssetId;
      await renderThumbnail({
        imageFile: keyframe ? (files.get(keyframe) ?? out.videoFile) : out.videoFile,
        out: thumbnail,
        spec,
        tools,
      });

      const video = await this.put(store, job.projectId, out.videoFile, 'video/mp4');
      const subtitle = await this.put(store, job.projectId, out.srtFile, 'application/x-subrip');
      const thumb = await this.put(store, job.projectId, thumbnail, 'image/jpeg');
      await prisma.$transaction(async (tx) => {
        const asset = (
          stored: StoredAsset,
          assetType: 'render' | 'subtitle' | 'image',
          extra: Partial<Prisma.AssetUncheckedCreateInput>,
        ) =>
          tx.asset.create({
            data: {
              id: stored.id,
              projectId: job.projectId,
              contentItemId: job.contentItemId,
              assetType,
              sourceType: 'generated',
              generationJobId: job.id,
              storageKey: stored.storageKey,
              mimeType: stored.mimeType,
              sizeBytes: BigInt(stored.sizeBytes),
              checksumSha256: stored.sha256Hex,
              createdById: job.requestedById,
              ...extra,
            },
          });
        await asset(video, 'render', {
          width: spec.width,
          height: spec.height,
          durationMs: qc.measured.durationMs ?? out.durationMs,
          label: 'Render',
          metadata: { renderId: render.id, upscaledFrom: render.upscaledFrom },
        });
        await asset(subtitle, 'subtitle', {
          label: 'Captions',
          metadata: { renderId: render.id, cues: out.cues.length },
        });
        await asset(thumb, 'image', {
          width: spec.width,
          height: spec.height,
          label: 'Thumbnail',
          metadata: { renderId: render.id, thumbnail: true },
        });
        const inputs: Prisma.AssetInputCreateManyInput[] = [];
        const link = (inputAssetId: string, role: string) => {
          if (!inputs.some((i) => i.inputAssetId === inputAssetId && i.role === role)) {
            inputs.push({ projectId: job.projectId, assetId: video.id, inputAssetId, role });
          }
        };
        for (const s of manifest.scenes) {
          link(s.clipAssetId, 'clip');
          if (s.voiceoverAssetId) link(s.voiceoverAssetId, 'voiceover');
        }
        if (manifest.music) link(manifest.music.assetId, 'music');
        for (const x of manifest.audio?.sfx ?? []) link(x.assetId, 'sfx');
        if (keyframe) {
          inputs.push({
            projectId: job.projectId,
            assetId: thumb.id,
            inputAssetId: keyframe,
            role: 'keyframe',
          });
        }
        await tx.assetInput.createMany({ data: inputs });
        await tx.render.update({
          where: { id: render.id },
          data: {
            videoAssetId: video.id,
            subtitleAssetId: subtitle.id,
            thumbnailAssetId: thumb.id,
            durationMs: qc.measured.durationMs ?? out.durationMs,
            qc: toJson(report),
          },
        });
        if (!(await jobs.succeedRenderIn(tx, job, render.id))) throw new MediaDiscardedError();
      });
      logger.log('info', 'render_completed', {
        jobId: job.id,
        renderId: render.id,
        elapsedMs: report.elapsedMs,
        warnings: qc.findings.length,
      });
      return render.id;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Every input once, streamed to the work directory (assets are write-once, M4). */
  private async download(
    projectId: string,
    manifest: RenderManifest,
    dir: string,
    store: ObjectStore,
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const s of manifest.scenes) {
      ids.add(s.clipAssetId);
      if (s.voiceoverAssetId) ids.add(s.voiceoverAssetId);
    }
    if (manifest.music) ids.add(manifest.music.assetId);
    for (const x of manifest.audio?.sfx ?? []) ids.add(x.assetId);
    const keyframe = manifest.scenes[0]?.keyframeAssetId;
    if (keyframe) ids.add(keyframe);
    const rows = await this.deps.prisma.asset.findMany({
      where: { projectId, id: { in: [...ids] } },
      select: { id: true, storageKey: true, sizeBytes: true },
    });
    const files = new Map<string, string>();
    for (const [i, id] of [...ids].entries()) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.sizeBytes > BigInt(MAX_INPUT_BYTES)) {
        throw new MediaPermanentError(
          'REFERENCE_MISSING',
          `input asset ${id} is missing or too large`,
        );
      }
      const body = await store.get(row.storageKey);
      if (!body)
        throw new MediaPermanentError('REFERENCE_MISSING', `input asset ${id} has no stored file`);
      const file = path.join(dir, `input-${String(i)}${path.extname(row.storageKey)}`);
      await pipeline(body.stream, createWriteStream(file, { mode: 0o600 }));
      files.set(id, file);
    }
    return files;
  }

  private async put(
    store: ObjectStore,
    projectId: string,
    file: string,
    mimeType: StoredMimeType,
  ): Promise<StoredAsset> {
    const bytes = new Uint8Array(await readFile(file));
    const sha256Hex = await sha256File(file);
    const id = uuidv7();
    const storageKey = assetObjectKey({ projectId, assetId: id, sha256Hex, mimeType });
    await store.putIfAbsent(storageKey, bytes, { contentType: mimeType, sha256Hex });
    return { id, storageKey, mimeType, sizeBytes: bytes.byteLength, sha256Hex };
  }
}

interface StoredAsset {
  readonly id: string;
  readonly storageKey: string;
  readonly mimeType: StoredMimeType;
  readonly sizeBytes: number;
  readonly sha256Hex: string;
}

const toJson = (value: unknown): Prisma.InputJsonObject =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

function qcSummary(qc: QcReport): string {
  const errors = qc.findings
    .filter((f) => f.severity === 'error')
    .map((f) => `${f.check}: ${f.message}`);
  return `the render failed quality control (${errors.join('; ')})`.slice(0, 480);
}

/** The P4 mix of a `render.v2` manifest; undefined for M6 manifests (today's fixed mix). */
function audioMix(
  manifest: RenderManifest,
  files: ReadonlyMap<string, string>,
): RenderAudioMix | undefined {
  const audio = manifest.audio;
  if (!audio) return undefined;
  const muted = new Set(audio.scenes.filter((x) => x.muteMusic).map((x) => x.sceneNumber));
  return {
    voiceGainDb: audio.voice.gainDb,
    clipAudio: audio.clipAudio.enabled ? { gainDb: audio.clipAudio.gainDb } : null,
    musicFadeInMs: audio.music.fadeInMs,
    musicFadeOutMs: audio.music.fadeOutMs,
    musicDucking: audio.music.ducking,
    musicMutedScenes: manifest.scenes.flatMap((s, i) => (muted.has(s.sceneNumber) ? [i] : [])),
    sfx: audio.sfx.map((x) => ({
      file: files.get(x.assetId) ?? '',
      startMs: x.startMs,
      gainDb: x.gainDb,
    })),
  };
}
