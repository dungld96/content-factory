import { HttpStatus, Injectable } from '@nestjs/common';

import {
  SCRIPT_SCHEMA_VERSION,
  scriptContentSchema,
  scriptRuleIssues,
  STORYBOARD_SCHEMA_VERSION,
  storyboardContentSchema,
  storyboardRuleIssues,
  totalDuration,
  type RuleIssue,
  type StoryboardContent,
} from '@acf/content-domain';
import {
  ApiErrorCode,
  contentBriefSchema,
  type EditSceneRequest,
  type EditScriptRequest,
  type Page,
  type PaginationQuery,
  type ReviewRequest,
  type ScriptVersionDto,
  type StoryboardVersionDetailDto,
  type StoryboardVersionDto,
} from '@acf/contracts';
import type { ContentItem, TransactionClient } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound } from '../common/domain-errors.js';
import { keysetAfter, NEWEST_FIRST, toPage } from '../common/http/pagination.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { lockContent } from './generation.service.js';
import { toSceneDto, toScriptDto, toStoryboardDto } from './mappers.js';

/**
 * Script and storyboard versions (M3 design §6): immutable; every edit is a new version;
 * review happens once; approval moves the content item's pointer (version first, then parent).
 */
@Injectable()
export class ArtifactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
  ) {}

  // ------------------------------------------------------------------- scripts

  async listScripts(
    actor: Actor,
    contentId: string,
    query: PaginationQuery,
  ): Promise<Page<ScriptVersionDto>> {
    const item = await this.loadItem(contentId);
    await this.access.require(actor, item.projectId, 'viewer');
    const rows = await this.prisma.client.scriptVersion.findMany({
      where: { contentItemId: item.id, ...keysetAfter(query.cursor) },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, (v) => toScriptDto(v, item.approvedScriptVersionId));
  }

  async getScript(actor: Actor, id: string): Promise<ScriptVersionDto> {
    const { version, item } = await this.loadScript(id);
    await this.access.require(actor, item.projectId, 'viewer');
    return toScriptDto(version, item.approvedScriptVersionId);
  }

  /** A new `edited` version based on `id`; the original never changes (Q2). */
  async editScript(actor: Actor, id: string, input: EditScriptRequest): Promise<ScriptVersionDto> {
    const { version: base, item } = await this.loadScript(id);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    if (item.archivedAt) throw archived('content item');
    const content = scriptContentSchema.parse(input.content);
    const brief = contentBriefSchema.safeParse(item.brief);
    rejectIssues(
      scriptRuleIssues(content, {
        allowedSourceUrls: brief.success ? (brief.data.sourceUrls ?? []) : [],
      }),
    );
    const created = await this.prisma.client.$transaction(async (tx) => {
      await lockContent(tx, item.id);
      return tx.scriptVersion.create({
        data: {
          projectId: item.projectId,
          contentItemId: item.id,
          version: await nextVersion(tx, 'script', item.id),
          source: 'edited',
          basedOnVersionId: base.id,
          schemaVersion: SCRIPT_SCHEMA_VERSION,
          content: content,
          createdById: actor.userId,
        },
      });
    });
    return toScriptDto(created, item.approvedScriptVersionId);
  }

  async approveScript(actor: Actor, id: string): Promise<ScriptVersionDto> {
    const { item } = await this.loadScript(id);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    const result = await this.prisma.client.$transaction(async (tx) => {
      await review(tx, 'script', id, 'approved', actor.userId, undefined); // locks the VERSION
      await assertWritable(tx, item.id); // then the PARENT
      // Gate 1 moves; any approved storyboard of the previous script becomes stale (§6.3).
      const updated = await tx.contentItem.update({
        where: { id: item.id },
        data: { approvedScriptVersionId: id, approvedStoryboardVersionId: null },
      });
      return {
        version: await tx.scriptVersion.findUniqueOrThrow({ where: { id } }),
        item: updated,
      };
    });
    return toScriptDto(result.version, result.item.approvedScriptVersionId);
  }

  async rejectScript(actor: Actor, id: string, input: ReviewRequest): Promise<ScriptVersionDto> {
    const { item } = await this.loadScript(id);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    const version = await this.prisma.client.$transaction(async (tx) => {
      await review(tx, 'script', id, 'rejected', actor.userId, input.note);
      await assertWritable(tx, item.id);
      return tx.scriptVersion.findUniqueOrThrow({ where: { id } });
    });
    return toScriptDto(version, item.approvedScriptVersionId);
  }

  // ------------------------------------------------------------------- storyboards

  async listStoryboards(
    actor: Actor,
    contentId: string,
    query: PaginationQuery,
  ): Promise<Page<StoryboardVersionDto>> {
    const item = await this.loadItem(contentId);
    await this.access.require(actor, item.projectId, 'viewer');
    const rows = await this.prisma.client.storyboardVersion.findMany({
      where: { contentItemId: item.id, ...keysetAfter(query.cursor) },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, (v) => toStoryboardDto(v, item));
  }

  async getStoryboard(actor: Actor, id: string): Promise<StoryboardVersionDetailDto> {
    const version = await this.prisma.client.storyboardVersion.findUnique({
      where: { id },
      include: { scenes: { orderBy: { sceneNumber: 'asc' }, include: { referenceAssets: true } } },
    });
    if (!version) throw notFound('storyboard version');
    const item = await this.loadItem(version.contentItemId);
    await this.access.require(actor, item.projectId, 'viewer');
    return { ...toStoryboardDto(version, item), scenes: version.scenes.map(toSceneDto) };
  }

  /** A new storyboard version with one scene changed and the others copied (Q2). */
  async editScene(
    actor: Actor,
    sceneId: string,
    changes: EditSceneRequest,
  ): Promise<StoryboardVersionDetailDto> {
    const scene = await this.prisma.client.storyboardScene.findUnique({ where: { id: sceneId } });
    if (!scene) throw notFound('scene');
    const base = await this.prisma.client.storyboardVersion.findUniqueOrThrow({
      where: { id: scene.storyboardVersionId },
      include: { scenes: { orderBy: { sceneNumber: 'asc' }, include: { referenceAssets: true } } },
    });
    const item = await this.loadItem(base.contentItemId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    if (item.archivedAt) throw archived('content item');

    const content: StoryboardContent = storyboardContentSchema.parse({
      scenes: base.scenes.map((s) => {
        const dto: Partial<ReturnType<typeof toSceneDto>> = toSceneDto(s);
        delete dto.id;
        return s.id === sceneId ? { ...dto, ...changes, sceneNumber: s.sceneNumber } : dto;
      }),
    });
    const ids = (pick: (s: StoryboardContent['scenes'][number]) => (string | null)[]) => [
      ...new Set(content.scenes.flatMap(pick).filter((x): x is string => x !== null)),
    ];
    // Human edits keep numbering and total duration; ids are kept in the project by FKs.
    rejectIssues(
      storyboardRuleIssues(content, {
        targetDurationSeconds: item.targetDurationSeconds,
        allowedCharacterVersionIds: ids((s) => [s.characterVersionId]),
        allowedEnvironmentVersionIds: ids((s) => [s.environmentVersionId]),
        allowedAssetIds: ids((s) => s.requiredReferenceAssetIds),
      }),
    );

    const id = await this.prisma.client.$transaction(async (tx) => {
      await lockContent(tx, item.id);
      const created = await tx.storyboardVersion.create({
        data: {
          projectId: item.projectId,
          contentItemId: item.id,
          scriptVersionId: base.scriptVersionId,
          version: await nextVersion(tx, 'storyboard', item.id),
          source: 'edited',
          basedOnVersionId: base.id,
          schemaVersion: STORYBOARD_SCHEMA_VERSION,
          totalDurationSeconds: totalDuration(content).toFixed(2),
          createdById: actor.userId,
        },
      });
      for (const s of content.scenes) {
        const row = await tx.storyboardScene.create({
          data: {
            projectId: item.projectId,
            storyboardVersionId: created.id,
            sceneNumber: s.sceneNumber,
            durationSeconds: s.durationSeconds.toFixed(2),
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
            acceptanceChecks: s.acceptanceChecks,
          },
        });
        const assetIds = [...new Set(s.requiredReferenceAssetIds)];
        if (assetIds.length > 0) {
          await tx.storyboardSceneAsset.createMany({
            data: assetIds.map((assetId) => ({
              projectId: item.projectId,
              sceneId: row.id,
              assetId,
            })),
          });
        }
      }
      return created.id;
    });
    return this.getStoryboard(actor, id);
  }

  async approveStoryboard(actor: Actor, id: string): Promise<StoryboardVersionDto> {
    const version = await this.prisma.client.storyboardVersion.findUnique({ where: { id } });
    if (!version) throw notFound('storyboard version');
    const item = await this.loadItem(version.contentItemId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    if (
      version.status === 'pending_review' &&
      version.scriptVersionId !== item.approvedScriptVersionId
    ) {
      throw stale();
    }
    const updated = await this.prisma.client.$transaction(async (tx) => {
      // The trigger re-checks staleness under the version lock (AC013 → STALE_STORYBOARD).
      await review(tx, 'storyboard', id, 'approved', actor.userId, undefined);
      await assertWritable(tx, item.id);
      return tx.contentItem.update({
        where: { id: item.id },
        data: { approvedStoryboardVersionId: id },
      });
    });
    const fresh = await this.prisma.client.storyboardVersion.findUniqueOrThrow({ where: { id } });
    return toStoryboardDto(fresh, updated);
  }

  async rejectStoryboard(
    actor: Actor,
    id: string,
    input: ReviewRequest,
  ): Promise<StoryboardVersionDto> {
    const version = await this.prisma.client.storyboardVersion.findUnique({ where: { id } });
    if (!version) throw notFound('storyboard version');
    const item = await this.loadItem(version.contentItemId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    await this.prisma.client.$transaction(async (tx) => {
      await review(tx, 'storyboard', id, 'rejected', actor.userId, input.note);
      await assertWritable(tx, item.id);
    });
    const fresh = await this.prisma.client.storyboardVersion.findUniqueOrThrow({ where: { id } });
    return toStoryboardDto(fresh, item);
  }

  // ------------------------------------------------------------------- internals

  private async loadScript(id: string) {
    const version = await this.prisma.client.scriptVersion.findUnique({ where: { id } });
    if (!version) throw notFound('script version');
    return { version, item: await this.loadItem(version.contentItemId) };
  }

  private async loadItem(id: string): Promise<ContentItem> {
    const item = await this.prisma.client.contentItem.findUnique({ where: { id } });
    if (!item) throw notFound('content item');
    return item;
  }
}

/** One-time review of a pending version; 409 when it was already reviewed (AC012 backstop). */
async function review(
  tx: TransactionClient,
  kind: 'script' | 'storyboard',
  id: string,
  status: 'approved' | 'rejected',
  userId: string,
  note: string | undefined,
): Promise<void> {
  const data = { status, reviewedById: userId, reviewedAt: new Date(), reviewNote: note ?? null };
  const { count } =
    kind === 'script'
      ? await tx.scriptVersion.updateMany({ where: { id, status: 'pending_review' }, data })
      : await tx.storyboardVersion.updateMany({ where: { id, status: 'pending_review' }, data });
  if (count !== 1) {
    throw new ApiError({
      status: HttpStatus.CONFLICT,
      code: ApiErrorCode.ArtifactImmutable,
      message: 'This version was already reviewed; edits create a new version.',
    });
  }
}

/** Locks the content item (after the version) and refuses archived items. */
async function assertWritable(tx: TransactionClient, contentItemId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ archived_at: Date | null }[]>`
    SELECT archived_at FROM content_items WHERE id = ${contentItemId}::uuid FOR NO KEY UPDATE`;
  if (rows[0]?.archived_at) throw archived('content item');
}

async function nextVersion(
  tx: TransactionClient,
  kind: 'script' | 'storyboard',
  contentItemId: string,
): Promise<number> {
  const rows =
    kind === 'script'
      ? await tx.$queryRaw<
          { max: number | null }[]
        >`SELECT max(version)::int AS max FROM script_versions WHERE content_item_id = ${contentItemId}::uuid`
      : await tx.$queryRaw<
          { max: number | null }[]
        >`SELECT max(version)::int AS max FROM storyboard_versions WHERE content_item_id = ${contentItemId}::uuid`;
  return (rows[0]?.max ?? 0) + 1;
}

function rejectIssues(issues: readonly RuleIssue[]): void {
  if (issues.length === 0) return;
  throw new ApiError({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ApiErrorCode.ValidationFailed,
    message: 'The content breaks a rule.',
    details: issues.map((i) => ({ path: `body.${i.path}`, message: i.message })),
  });
}

const stale = () =>
  new ApiError({
    status: HttpStatus.CONFLICT,
    code: ApiErrorCode.StaleStoryboard,
    message: "This storyboard's script is no longer the approved script.",
  });
