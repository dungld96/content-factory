'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  CostReportDto,
  CreateRenderResponseDto,
  RenderDto,
  RenderPlanDto,
} from '@acf/contracts';

import { Icon } from '@/components/icon';
import { CancelRunButton } from '@/components/cancel-run';
import { LocalTime } from '@/components/local-time';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { formatSeconds, jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';
import { audioRequest, DEFAULT_AUDIO, VOICE_BLOCKERS, type AudioState } from '@/lib/render-audio';

import { RenderAudioSection } from './render-audio';

const BLOCKER_TAB: Readonly<Record<RenderPlanDto['blockers'][number]['code'], string>> = {
  STORYBOARD_NOT_APPROVED: 'storyboard',
  CLIPS_INCOMPLETE: 'clips',
  VOICEOVERS_INCOMPLETE: 'voiceover',
  VOICEOVER_EXCEEDS_SCENE: 'voiceover',
  INPUT_FILE_MISSING: 'clips',
  STORAGE_NOT_CONFIGURED: 'activity',
};

const STAGE_LABEL: Readonly<Record<string, string>> = {
  normalise: 'Preparing scenes',
  concat: 'Joining scenes',
  narration: 'Building narration',
  mix: 'Mixing audio',
  loudness: 'Measuring loudness',
  encode: 'Encoding the final video',
};

/** What a reviewer checks by eye at gate 5 (CONTENT_PIPELINE stage 10). */
const HUMAN_CHECKS = [
  'Character identity matches the master',
  'Brand and environment are consistent',
  'Facts and claims are correct',
  'No visual defects (hands, text, artefacts)',
  'Voice-over is clear and in sync with the scenes',
  'Suitable for the target platform',
];

/**
 * Render and export (M6 design §12): preflight, options, render, then review each render with its
 * QC report, approve (gate 5) and export the publishing package.
 */
export function RenderPanel(props: {
  readonly contentId: string;
  readonly plan: RenderPlanDto;
  readonly renders: readonly RenderDto[];
  readonly cost: CostReportDto | null;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const { plan, renders, canEdit } = props;
  const [burnIn, setBurnIn] = useState(true);
  const [musicId, setMusicId] = useState('');
  const [volume, setVolume] = useState(-18);
  const [audio, setAudio] = useState<AudioState>(DEFAULT_AUDIO);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P4 S5: with the voice layer off, the voice-over blockers do not apply (the API re-checks).
  const blockers = audio.voiceEnabled
    ? plan.blockers
    : plan.blockers.filter((b) => !VOICE_BLOCKERS.has(b.code));
  const ready = blockers.length === 0 && !plan.renderInProgress;

  async function run<T>(path: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await mutate<T>('POST', path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return null;
    }
    return r.data;
  }

  async function render(regenerate = false) {
    const result = await run<CreateRenderResponseDto>(`/content/${props.contentId}/renders`, {
      captions: { burnIn },
      ...(musicId ? { music: { assetId: musicId, volumeDb: volume } } : {}),
      ...(audioRequest(audio) ? { audio: audioRequest(audio) } : {}),
      ...(regenerate ? { regenerate: true } : {}),
    });
    if (result) {
      toast(result.reused ? 'An identical render already exists.' : 'Render queued.');
      router.refresh();
    }
  }

  async function act(path: string, body?: unknown, message?: string) {
    if ((await run(path, body)) !== null) {
      if (message) toast(message);
      router.refresh();
    }
  }

  return (
    <div aria-label="Render controls">
      <div className="section-head">
        <div>
          <h2>Render & export</h2>
          <p>
            Assemble the chosen clips and voice-overs into the final 9:16 video, review it, export.
          </p>
        </div>
        <span className={ready ? 'status green' : 'status gray'} aria-label="Render readiness">
          {plan.renderInProgress
            ? 'Rendering…'
            : ready
              ? `Ready: ${String(plan.scenes.length)} scenes, ${String(plan.totalSeconds)} s`
              : `${String(blockers.length)} item(s) to fix`}
        </span>
      </div>

      {blockers.length > 0 && (
        <ul className="plain-list" aria-label="Render blockers">
          {blockers.map((b) => (
            <li key={`${b.code}-${String(b.sceneNumber)}`} className="form-error">
              {b.message}{' '}
              <a href={`#${BLOCKER_TAB[b.code]}`} className="small-text">
                Fix
              </a>
            </li>
          ))}
        </ul>
      )}
      {plan.upscaledFrom && (
        <p className="muted small-text">
          Clips are {plan.upscaledFrom} and will be scaled up to 1080×1920; the render is labelled
          “upscaled from {plan.upscaledFrom}”. Generate 1080p clips for full resolution.
        </p>
      )}

      {canEdit && (
        <div className="image-toolbar">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={burnIn}
              onChange={(e) => {
                setBurnIn(e.target.checked);
              }}
            />
            Burn captions into the video
          </label>
          <label className="field">
            Background music
            <select
              value={musicId}
              onChange={(e) => {
                setMusicId(e.target.value);
              }}
            >
              <option value="">No music</option>
              {plan.musicOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.originalFilename ?? m.label ?? m.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          {musicId && (
            <label className="field">
              Music level (dB)
              <input
                type="number"
                min={-40}
                max={0}
                step={1}
                value={volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                }}
              />
            </label>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={busy || !ready}
            onClick={() => void render()}
          >
            <Icon name="render" /> Render video
          </button>
        </div>
      )}
      {canEdit && plan.scenes.length > 0 && (
        <RenderAudioSection
          plan={plan}
          state={audio}
          hasMusic={musicId !== ''}
          onChange={setAudio}
        />
      )}
      {canEdit && plan.musicOptions.length === 0 && (
        <p className="muted small-text">
          To add music, upload a music file with its licence note in the Asset library and approve
          it.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {renders.length === 0 ? (
        <div className="empty">No renders yet.</div>
      ) : (
        renders.map((r, i) => (
          <RenderCard
            key={r.id}
            render={r}
            index={renders.length - i}
            cost={i === 0 ? props.cost : null}
            canEdit={canEdit}
            busy={busy}
            onApprove={(note) =>
              void act(`/renders/${r.id}/approve`, note ? { note } : {}, 'Render approved.')
            }
            onReject={(note) => void act(`/renders/${r.id}/reject`, { note }, 'Render rejected.')}
            onExport={() =>
              void act(
                `/renders/${r.id}/export`,
                undefined,
                'Exported. The package is ready to download.',
              )
            }
          />
        ))
      )}
    </div>
  );
}

function RenderCard(props: {
  readonly render: RenderDto;
  readonly index: number;
  readonly cost: CostReportDto | null;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onApprove: (note: string) => void;
  readonly onReject: (note: string) => void;
  readonly onExport: () => void;
}) {
  const { render: r } = props;
  const [note, setNote] = useState('');
  const warnings = r.qc?.findings.filter((f) => f.severity === 'warning') ?? [];
  const errors = r.qc?.findings.filter((f) => f.severity === 'error') ?? [];
  const reviewable = r.status === 'succeeded' && r.reviewStatus === 'pending';
  return (
    <article className="scene-images" aria-label={`Render ${String(props.index)}`}>
      <div className="section-head">
        <div>
          <h3>
            Render {props.index}{' '}
            {r.status === 'succeeded' ? (
              r.reviewStatus === 'approved' ? (
                <Pill tone="green">{r.exportedAt ? 'Approved · exported' : 'Approved'}</Pill>
              ) : r.reviewStatus === 'rejected' ? (
                <Pill tone="red">Rejected</Pill>
              ) : (
                <Pill tone="amber">Review required</Pill>
              )
            ) : r.status === 'failed' || r.status === 'canceled' ? (
              <Pill tone="red">{r.status === 'failed' ? 'Failed' : 'Canceled'}</Pill>
            ) : (
              <Pill tone="purple">Rendering</Pill>
            )}
            {r.isApproved && <Pill tone="green">Current export</Pill>}
          </h3>
          <p>
            <LocalTime iso={r.createdAt} /> ·{' '}
            {r.burnInCaptions ? 'captions burned in' : 'captions as SRT only'}
            {r.musicAssetId ? ' · with music' : ''}
            {r.durationMs ? ` · ${formatSeconds(r.durationMs)}` : ''}
            {r.upscaledFrom ? ` · upscaled from ${r.upscaledFrom}` : ''}
          </p>
          {(r.status === 'queued' || r.status === 'running') && (
            <p role="status">
              {r.stage ? (STAGE_LABEL[r.stage] ?? r.stage) : 'Waiting for the render worker'}…
            </p>
          )}
          {props.canEdit && (r.status === 'queued' || r.status === 'running') && (
            <CancelRunButton runId={r.job.productionRunId} what="this render" />
          )}
          {r.job.errorCode && (
            <p className="form-error" role="alert">
              {jobErrorText(r.job.errorCode)}
              {r.job.errorMessage ? ` (${r.job.errorMessage})` : ''}
            </p>
          )}
          {r.reviewNote && <p className="muted small-text">Review note: {r.reviewNote}</p>}
        </div>
      </div>

      {r.video && (
        <div className="render-body">
          <video
            className="render-player"
            src={assetContentUrl(r.video.id)}
            poster={r.thumbnail ? assetContentUrl(r.thumbnail.id) : undefined}
            controls
            preload="metadata"
            playsInline
            aria-label={`Play render ${String(props.index)}`}
          />
          <div className="render-side">
            <h4>Automated checks</h4>
            <p className="small-text">
              {errors.length === 0 ? (
                <>
                  <Icon name="check" /> Passed
                </>
              ) : (
                <>
                  <Icon name="failed" /> Failed
                </>
              )}{' '}
              · {r.qc?.measured.width ?? '?'}×{r.qc?.measured.height ?? '?'} ·{' '}
              {r.qc?.measured.fps ?? '?'} fps · {r.qc?.measured.integratedLufs ?? '?'} LUFS
            </p>
            {warnings.length > 0 ? (
              <ul className="plain-list small-text" aria-label="QC warnings">
                {warnings.map((w) => (
                  <li key={`${w.check}-${w.message}`}>
                    <Icon name="warning" /> {w.scene ? `Scene ${String(w.scene)}: ` : ''}
                    {w.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small-text">No warnings.</p>
            )}
            {reviewable && (
              <>
                <h4>Human review</h4>
                <ul className="plain-list small-text" aria-label="Human review checklist">
                  {HUMAN_CHECKS.map((c) => (
                    <li key={c}>
                      <Icon name="todo" /> {c}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {props.cost && (
              <>
                <h4>Cost of this content</h4>
                <p className="small-text" aria-label="Cost summary">
                  Reported {formatUsd(props.cost.total.reportedUsd)} · estimated{' '}
                  {formatUsd(props.cost.total.estimatedUsd)}
                  {props.cost.total.unknownCalls > 0
                    ? ` · ${String(props.cost.total.unknownCalls)} call(s) of unknown cost`
                    : ''}{' '}
                  · rendering {formatUsd(props.cost.renderCostUsd)}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {props.canEdit && reviewable && (
        <div className="review-actions">
          <label className="field">
            Review note <small>(required to reject)</small>
            <input
              value={note}
              maxLength={2000}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={props.busy}
            onClick={() => {
              props.onApprove(note.trim());
            }}
          >
            Approve render
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={props.busy || note.trim() === ''}
            onClick={() => {
              props.onReject(note.trim());
            }}
          >
            Reject
          </button>
        </div>
      )}
      {props.canEdit && r.reviewStatus === 'approved' && !r.exportedAt && (
        <div className="review-actions">
          <button
            type="button"
            className="btn primary"
            disabled={props.busy}
            onClick={props.onExport}
          >
            Export package
          </button>
        </div>
      )}
      {r.exportedAt && (
        <ul className="plain-list small-text" aria-label="Package downloads">
          {r.video && (
            <li>
              <a href={assetContentUrl(r.video.id)} download="video.mp4">
                video.mp4
              </a>
            </li>
          )}
          {r.subtitles && (
            <li>
              <a href={assetContentUrl(r.subtitles.id)} download="captions.srt">
                captions.srt
              </a>
            </li>
          )}
          {r.thumbnail && (
            <li>
              <a href={assetContentUrl(r.thumbnail.id)} download="thumbnail.jpg">
                thumbnail.jpg
              </a>
            </li>
          )}
          <li>
            <a href={`/api/v1/renders/${r.id}/manifest`} download="manifest.json">
              manifest.json
            </a>
          </li>
          <li>
            <a href={`/api/v1/renders/${r.id}/cost-report`} download="cost-report.json">
              cost-report.json
            </a>
          </li>
        </ul>
      )}
    </article>
  );
}
