// Video and TTS job fixtures (M5 design §5–§7): mock media models and jobs created exactly as
// the API does (intent first), on top of the image world (approved storyboard, stored image).
import { randomUUID } from 'node:crypto';

import {
  activeSceneJobKey,
  clipContentHash,
  executionKey,
  voiceoverContentHash,
  type TtsJobInput,
  type VideoJobInput,
} from '@acf/content-domain';
import type { PrismaClient } from '@acf/database';

import type { World } from './fixtures.js';
import type { ImageWorld } from './images.js';

export interface MediaWorld {
  readonly videoModelId: string;
  readonly ttsModelId: string;
}

const PRICE_AT = new Date('2026-01-01T00:00:00Z');

export async function createMediaModels(prisma: PrismaClient): Promise<MediaWorld> {
  const provider = await prisma.aiProvider.findUniqueOrThrow({ where: { key: 'mock' } });
  const video = await prisma.aiModel.create({
    data: {
      providerId: provider.id,
      modelKey: 'mock/still-video',
      displayName: 'Mock video',
      qualityTier: 'premium',
      status: 'enabled',
      outputModalities: ['video'],
      mediaConstraints: {
        kind: 'video',
        durations: [2, 4, 6, 8],
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['9:16', '1:1', '16:9'],
        frameImages: ['first_frame'],
        audio: false,
        seed: true,
      },
      capabilities: { create: { capability: 'video_generation' } },
      prices: {
        create: {
          metric: 'output_video_seconds',
          unitPrice: '0.05',
          sourceValue: '0.05',
          effectiveFrom: PRICE_AT,
          source: 'manual_estimate',
          sourceUrl: 'urn:acf:test',
          capturedAt: PRICE_AT,
        },
      },
    },
  });
  const tts = await prisma.aiModel.create({
    data: {
      providerId: provider.id,
      modelKey: 'mock/tone-tts',
      displayName: 'Mock speech',
      qualityTier: 'premium',
      status: 'enabled',
      outputModalities: ['speech'],
      mediaConstraints: { kind: 'tts', voices: ['mock-a', 'mock-b'], mp3: true },
      capabilities: { create: { capability: 'tts' } },
      prices: {
        create: {
          metric: 'input_characters',
          unitPrice: '0.00001',
          sourceValue: '10',
          effectiveFrom: PRICE_AT,
          source: 'manual_estimate',
          sourceUrl: 'urn:acf:test',
          capturedAt: PRICE_AT,
        },
      },
    },
  });
  return { videoModelId: video.id, ttsModelId: tts.id };
}

async function sceneOf(prisma: PrismaClient, sceneId: string) {
  return prisma.storyboardScene.findUniqueOrThrow({ where: { id: sceneId } });
}

/** Video job input for one scene; the stored reference image stands in for the keyframe. */
export async function videoInput(
  prisma: PrismaClient,
  iw: ImageWorld,
  mw: MediaWorld,
  sceneId: string,
  overrides: Partial<VideoJobInput> = {},
): Promise<VideoJobInput> {
  const s = await sceneOf(prisma, sceneId);
  const scene = {
    sceneNumber: s.sceneNumber,
    durationSeconds: Number(s.durationSeconds),
    videoPrompt: s.videoPrompt,
    cameraMovement: s.cameraMovement,
    characterAction: s.characterAction,
    visualDescription: s.visualDescription,
  };
  const settings = {
    durationSeconds: 2,
    resolution: '720p' as const,
    aspectRatio: '9:16' as const,
    generateAudio: false,
  };
  return {
    storyboardVersionId: iw.storyboardVersionId,
    sceneId,
    scene,
    keyframeAssetId: iw.referenceAssetId,
    ...settings,
    seed: 11,
    clipHash: clipContentHash({
      scene,
      keyframeAssetId: iw.referenceAssetId,
      modelId: mw.videoModelId,
      ...settings,
    }),
    qualityTier: 'balanced',
    ...overrides,
  };
}

export async function ttsInput(
  prisma: PrismaClient,
  iw: ImageWorld,
  mw: MediaWorld,
  sceneId: string,
  text = 'Xin chào, đây là sản phẩm mới của chúng tôi.',
): Promise<TtsJobInput> {
  const s = await sceneOf(prisma, sceneId);
  const voice = { voice: 'mock-a', language: 'vi', speed: null, instructions: null };
  return {
    storyboardVersionId: iw.storyboardVersionId,
    sceneId,
    sceneNumber: s.sceneNumber,
    text,
    sceneDurationSeconds: Number(s.durationSeconds),
    voice: { voiceProfileId: randomUUID(), ...voice },
    voiceoverHash: voiceoverContentHash({ text, modelId: mw.ttsModelId, voice }),
    qualityTier: 'balanced',
  };
}

/** One run with one media job per input (API M5d), content item → generating_assets. */
export async function createMediaJobs(
  prisma: PrismaClient,
  w: World,
  kind: 'video_generation' | 'tts_generation',
  modelId: string,
  inputs: readonly (VideoJobInput | TtsJobInput)[],
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: w.contentItemId } });
    const run = await tx.productionRun.create({
      data: { projectId: w.projectId, contentItemId: w.contentItemId, requestedById: w.userId },
    });
    const ids: string[] = [];
    for (const input of inputs) {
      const template = kind === 'video_generation' ? 'video.v1' : 'tts.v1';
      const hash = 'clipHash' in input ? input.clipHash : input.voiceoverHash;
      const job = await tx.generationJob.create({
        data: {
          projectId: w.projectId,
          contentItemId: w.contentItemId,
          productionRunId: run.id,
          kind,
          storyboardSceneId: input.sceneId,
          activeKey: activeSceneJobKey(input.sceneId, kind),
          idempotencyKey: randomUUID(),
          executionKey: executionKey({
            kind,
            contentItemId: w.contentItemId,
            brief: { hash },
            inputVersionIds: [input.sceneId],
            promptTemplateId: template,
            modelId,
          }),
          input,
          previousContentStatus: item.status,
          promptTemplateId: template,
          modelId,
          requestedById: w.userId,
        },
      });
      await tx.jobEvent.create({
        data: {
          projectId: w.projectId,
          jobId: job.id,
          toStatus: 'queued',
          attempt: 0,
          detail: { type: 'created' },
        },
      });
      ids.push(job.id);
    }
    await tx.contentItem.update({
      where: { id: w.contentItemId },
      data: { status: 'generating_assets' },
    });
    return ids;
  });
}
