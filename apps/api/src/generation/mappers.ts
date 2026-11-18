import { UsdAmount } from '@acf/ai-core';
import { usdFromDecimal } from '@acf/ai-runtime';
import type { ScriptContent } from '@acf/content-domain';
import type {
  GenerationJobDto,
  JobCostDto,
  ScriptVersionDto,
  StoryboardSceneDto,
  StoryboardVersionDto,
} from '@acf/contracts';
import type {
  AiInvocation,
  GenerationJob,
  JobEvent,
  ScriptVersion,
  StoryboardScene,
  StoryboardSceneAsset,
  StoryboardVersion,
} from '@acf/database';

type CostRow = Pick<AiInvocation, 'costStatus' | 'reportedCost' | 'estimatedCost'>;

/** Ledger rows → cost summary (ADR-0012): unknown cost is counted, never summed as zero. */
export function costSummary(rows: readonly CostRow[]): JobCostDto {
  let reported = UsdAmount.ZERO;
  let estimated = UsdAmount.ZERO;
  let unknownCalls = 0;
  for (const row of rows) {
    if (row.costStatus === 'reported' && row.reportedCost)
      reported = reported.add(usdFromDecimal(row.reportedCost));
    else if (row.costStatus === 'estimated' && row.estimatedCost)
      estimated = estimated.add(usdFromDecimal(row.estimatedCost));
    else unknownCalls += 1;
  }
  return {
    calls: rows.length,
    reportedUsd: reported.toString(),
    estimatedUsd: estimated.toString(),
    unknownCalls,
  };
}

export function toJobDto(job: GenerationJob, modelKey: string, cost: JobCostDto): GenerationJobDto {
  return {
    id: job.id,
    projectId: job.projectId,
    contentItemId: job.contentItemId,
    productionRunId: job.productionRunId,
    kind: job.kind,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    modelKey,
    promptTemplateId: job.promptTemplateId,
    resultScriptVersionId: job.resultScriptVersionId,
    resultStoryboardVersionId: job.resultStoryboardVersionId,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    cost,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export function toEventDto(e: JobEvent) {
  const detail = (e.detail ?? {}) as { type?: unknown; errorCode?: unknown };
  return {
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    attempt: e.attempt,
    type: typeof detail.type === 'string' ? detail.type : 'unknown',
    errorCode: typeof detail.errorCode === 'string' ? detail.errorCode : null,
    createdAt: e.createdAt.toISOString(),
  };
}

const review = (v: ScriptVersion | StoryboardVersion) => ({
  status: v.status,
  source: v.source,
  basedOnVersionId: v.basedOnVersionId,
  generationJobId: v.generationJobId,
  createdById: v.createdById,
  reviewedById: v.reviewedById,
  reviewedAt: v.reviewedAt?.toISOString() ?? null,
  reviewNote: v.reviewNote,
  createdAt: v.createdAt.toISOString(),
});

export function toScriptDto(
  v: ScriptVersion,
  approvedScriptVersionId: string | null,
): ScriptVersionDto {
  return {
    id: v.id,
    contentItemId: v.contentItemId,
    version: v.version,
    ...review(v),
    isApproved: v.id === approvedScriptVersionId,
    schemaVersion: v.schemaVersion,
    // Written only after validation with scriptContentSchema (worker or edit).
    content: v.content as unknown as ScriptContent,
  };
}

export function toStoryboardDto(
  v: StoryboardVersion,
  pointers: { approvedScriptVersionId: string | null; approvedStoryboardVersionId: string | null },
): StoryboardVersionDto {
  return {
    id: v.id,
    contentItemId: v.contentItemId,
    scriptVersionId: v.scriptVersionId,
    version: v.version,
    ...review(v),
    totalDurationSeconds: Number(v.totalDurationSeconds.toFixed(2)),
    stale: v.scriptVersionId !== pointers.approvedScriptVersionId,
    isApproved: v.id === pointers.approvedStoryboardVersionId,
    schemaVersion: v.schemaVersion,
  };
}

export function toSceneDto(
  s: StoryboardScene & { referenceAssets: StoryboardSceneAsset[] },
): StoryboardSceneDto {
  return {
    id: s.id,
    sceneNumber: s.sceneNumber,
    durationSeconds: Number(s.durationSeconds.toFixed(2)),
    shotType: s.shotType,
    cameraAngle: s.cameraAngle,
    cameraMovement: s.cameraMovement,
    characterAction: s.characterAction,
    characterVersionId: s.characterVersionId,
    environmentVersionId: s.environmentVersionId,
    visualDescription: s.visualDescription,
    imagePrompt: s.imagePrompt,
    videoPrompt: s.videoPrompt,
    negativePrompt: s.negativePrompt,
    voiceOverSegment: s.voiceOverSegment,
    onScreenText: s.onScreenText,
    requiredReferenceAssetIds: s.referenceAssets.map((a) => a.assetId).sort(),
    acceptanceChecks: s.acceptanceChecks,
  };
}
