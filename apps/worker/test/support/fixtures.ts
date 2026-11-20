// Test fixtures for the worker: a project with a content item, the mock provider/model, and job
// creation exactly as the API does it (run + job + event + content status, intent first).
import { randomUUID } from 'node:crypto';

import { inject } from 'vitest';

import {
  activeJobKey,
  executionKey,
  type ScriptJobInput,
  type StoryboardJobInput,
  type TextJobKind,
} from '@acf/content-domain';
import { createPrismaClient, type PrismaClient } from '@acf/database';

export const appPrisma = (): PrismaClient =>
  createPrismaClient({ databaseUrl: inject('workerDatabaseUrls').appUrl, maxConnections: 4 });
export const migratorPrisma = (): PrismaClient =>
  createPrismaClient({ databaseUrl: inject('workerDatabaseUrls').migratorUrl, maxConnections: 2 });

export const TABLES = `users, sessions, projects, project_members, channels, characters, character_versions,
  character_version_assets, environments, environment_versions, environment_version_assets, assets,
  content_items, ai_providers, ai_models, ai_model_capabilities, ai_model_prices, ai_invocations,
  ai_usage_records, production_runs, generation_jobs, job_events, script_versions, storyboard_versions,
  storyboard_scenes, storyboard_scene_assets, ai_task_routes`;

export async function reset(migrator: PrismaClient): Promise<void> {
  await migrator.$executeRawUnsafe(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
}

export interface World {
  readonly userId: string;
  readonly projectId: string;
  readonly contentItemId: string;
  readonly modelId: string;
  readonly characterVersionId: string;
  readonly environmentVersionId: string;
  readonly assetId: string;
}

/** Owner, project, 30 s content item, approved character/environment masters, mock model. */
export async function createWorld(prisma: PrismaClient): Promise<World> {
  const user = await prisma.user.create({
    data: { email: `u-${randomUUID()}@example.test`, displayName: 'U', passwordHash: 'x' },
  });
  const project = await prisma.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: {
        name: 'W',
        slug: `w-${randomUUID().slice(0, 8)}`,
        defaultLanguage: 'vi',
        timezone: 'UTC',
        createdById: user.id,
      },
    });
    await tx.projectMember.create({ data: { projectId: p.id, userId: user.id, role: 'owner' } });
    return p;
  });
  const master = await prisma.contentMaster.create({
    data: {
      projectId: project.id,
      title: 'Desk gadgets',
      brief: { topic: 'Desk gadgets' },
      language: 'vi',
      createdById: user.id,
    },
  });
  const content = await prisma.contentItem.create({
    data: {
      projectId: project.id,
      contentMasterId: master.id,
      title: 'Desk gadgets',
      format: 'short_video',
      targetDurationSeconds: 30,
      aspectRatio: 'ratio_9_16',
      language: 'vi',
      brief: { topic: 'Desk gadgets' },
      createdById: user.id,
    },
  });
  const asset = await prisma.asset.create({
    data: {
      projectId: project.id,
      assetType: 'reference',
      sourceType: 'upload',
      storageKey: `p/${randomUUID()}.png`,
      mimeType: 'image/png',
      sizeBytes: 1n,
      checksumSha256: 'c'.repeat(64),
      createdById: user.id,
    },
  });
  const characterVersionId = await prisma.$transaction(async (tx) => {
    const c = await tx.character.create({
      data: { projectId: project.id, name: 'Khánh', slug: 'khanh', createdById: user.id },
    });
    const v = await tx.characterVersion.create({
      data: {
        projectId: project.id,
        characterId: c.id,
        version: 1,
        description: 'Friendly host',
        primaryAssetId: asset.id,
        createdById: user.id,
      },
    });
    await tx.characterVersion.update({
      where: { id: v.id },
      data: { status: 'approved', approvedAt: new Date(), approvedById: user.id },
    });
    await tx.character.update({ where: { id: c.id }, data: { masterVersionId: v.id } });
    return v.id;
  });
  const environmentVersionId = await prisma.$transaction(async (tx) => {
    const e = await tx.environment.create({
      data: { projectId: project.id, name: 'Office', slug: 'office', createdById: user.id },
    });
    const v = await tx.environmentVersion.create({
      data: {
        projectId: project.id,
        environmentId: e.id,
        version: 1,
        description: 'Open office',
        createdById: user.id,
      },
    });
    await tx.environmentVersion.update({
      where: { id: v.id },
      data: { status: 'approved', approvedAt: new Date(), approvedById: user.id },
    });
    await tx.environment.update({ where: { id: e.id }, data: { masterVersionId: v.id } });
    return v.id;
  });
  const provider = await prisma.aiProvider.upsert({
    where: { key: 'mock' },
    create: { key: 'mock', name: 'Mock', kind: 'mock', status: 'enabled' },
    update: {},
  });
  const model =
    (await prisma.aiModel.findFirst({
      where: { providerId: provider.id, modelKey: 'mock/echo' },
    })) ??
    (await prisma.aiModel.create({
      data: {
        providerId: provider.id,
        modelKey: 'mock/echo',
        displayName: 'Echo',
        qualityTier: 'economy',
        status: 'enabled',
        supportedParameters: [
          'max_tokens',
          'response_format',
          'structured_outputs',
          'seed',
          'stop',
          'temperature',
          'top_p',
        ],
        capabilities: { create: { capability: 'llm' } },
      },
    }));
  return {
    userId: user.id,
    projectId: project.id,
    contentItemId: content.id,
    modelId: model.id,
    characterVersionId,
    environmentVersionId,
    assetId: asset.id,
  };
}

export const scriptInput = (w: World, overrides: Partial<ScriptJobInput> = {}): ScriptJobInput => ({
  brief: {
    topic: 'Desk gadgets',
    audience: null,
    objective: null,
    tone: null,
    callToAction: null,
    notes: null,
    sourceUrls: [],
  },
  targetDurationSeconds: 30,
  language: 'vi',
  aspectRatio: '9:16',
  claimFlags: [],
  characterVersionId: w.characterVersionId,
  environmentVersionId: null,
  qualityTier: 'economy',
  ...overrides,
});

export const storyboardInput = (
  w: World,
  scriptVersionId: string,
  overrides: Partial<StoryboardJobInput> = {},
): StoryboardJobInput => ({
  scriptVersionId,
  targetDurationSeconds: 30,
  language: 'vi',
  aspectRatio: '9:16',
  characterVersionIds: [w.characterVersionId],
  environmentVersionIds: [w.environmentVersionId],
  qualityTier: 'economy',
  ...overrides,
});

/** Creates run + job + event and moves the content status, as the API does (M3d). */
export async function createJob(
  prisma: PrismaClient,
  w: World,
  kind: TextJobKind,
  input: ScriptJobInput | StoryboardJobInput,
  promptTemplateId: string = kind === 'script_generation' ? 'script.v1' : 'storyboard.v1',
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: w.contentItemId } });
    const run = await tx.productionRun.create({
      data: { projectId: w.projectId, contentItemId: w.contentItemId, requestedById: w.userId },
    });
    const job = await tx.generationJob.create({
      data: {
        projectId: w.projectId,
        contentItemId: w.contentItemId,
        productionRunId: run.id,
        kind,
        activeKey: activeJobKey(w.contentItemId, kind),
        idempotencyKey: randomUUID(),
        executionKey: executionKey({
          kind,
          contentItemId: w.contentItemId,
          brief: input,
          inputVersionIds: [],
          promptTemplateId,
          modelId: w.modelId,
        }),
        input: input,
        previousContentStatus: item.status,
        promptTemplateId,
        modelId: w.modelId,
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
    await tx.contentItem.update({
      where: { id: w.contentItemId },
      data: { status: kind === 'script_generation' ? 'scripting' : 'storyboarding' },
    });
    return job.id;
  });
}

/** Approves a script version and moves the pointer, as the API does (M3d). */
export async function approveScript(
  prisma: PrismaClient,
  w: World,
  scriptVersionId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.scriptVersion.update({
      where: { id: scriptVersionId },
      data: { status: 'approved', reviewedById: w.userId, reviewedAt: new Date() },
    });
    await tx.contentItem.update({
      where: { id: w.contentItemId },
      data: { approvedScriptVersionId: scriptVersionId, approvedStoryboardVersionId: null },
    });
  });
}
