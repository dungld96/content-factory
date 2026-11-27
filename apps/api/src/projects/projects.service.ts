import { Injectable } from '@nestjs/common';

import type {
  CreateProjectRequest,
  Page,
  ProjectDto,
  ProjectRole,
  UpdateProjectRequest,
} from '@acf/contracts';
import type { Project } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { definedOnly } from '../common/defined-only.js';
import { archived, guardedUpdateFailure } from '../common/domain-errors.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { TransactionRunner } from '../infrastructure/transaction-runner.js';
import { ProjectAccess } from './project-access.service.js';

export function toProjectDto(project: Project, role: ProjectRole): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    defaultLanguage: project.defaultLanguage,
    timezone: project.timezone,
    role,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TransactionRunner,
    private readonly access: ProjectAccess,
  ) {}

  /** Any active user may create a project; the creator becomes its owner in the same transaction. */
  async create(actor: Actor, input: CreateProjectRequest): Promise<ProjectDto> {
    const project = await this.tx.run('project.create', async (tx) => {
      const created = await tx.project.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          defaultLanguage: input.defaultLanguage,
          timezone: input.timezone,
          createdById: actor.userId,
        },
      });
      await tx.projectMember.create({
        data: {
          projectId: created.id,
          userId: actor.userId,
          role: 'owner',
          addedById: actor.userId,
        },
      });
      return created;
    });
    return toProjectDto(project, 'owner');
  }

  /** The caller's projects only, newest first. */
  async list(
    actor: Actor,
    query: { limit: number; cursor?: string | undefined; includeArchived: boolean },
  ): Promise<Page<ProjectDto>> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await this.prisma.client.projectMember.findMany({
      where: {
        userId: actor.userId,
        project: {
          ...(query.includeArchived ? {} : { archivedAt: null }),
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
      },
      orderBy: [{ project: { createdAt: 'desc' } }, { project: { id: 'desc' } }],
      take: query.limit + 1,
      select: { role: true, project: true },
    });
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1)?.project;
    return {
      data: visible.map((row) => toProjectDto(row.project, row.role)),
      page: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        limit: query.limit,
      },
    };
  }

  async get(actor: Actor, projectId: string): Promise<ProjectDto> {
    const grant = await this.access.require(actor, projectId, 'viewer');
    const project = await this.prisma.client.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    return toProjectDto(project, grant.role);
  }

  async update(
    actor: Actor,
    projectId: string,
    input: UpdateProjectRequest,
    expected: Date | undefined,
  ): Promise<ProjectDto> {
    const grant = await this.access.require(actor, projectId, 'owner', { mutation: true });
    const { count } = await this.prisma.client.project.updateMany({
      where: { id: projectId, archivedAt: null, ...(expected ? { updatedAt: expected } : {}) },
      data: definedOnly(input),
    });
    const current = await this.prisma.client.project.findUnique({ where: { id: projectId } });
    if (count === 0 || !current) throw guardedUpdateFailure(current, 'project');
    return toProjectDto(current, grant.role);
  }

  async archive(actor: Actor, projectId: string): Promise<ProjectDto> {
    const grant = await this.access.require(actor, projectId, 'owner');
    const { count } = await this.prisma.client.project.updateMany({
      where: { id: projectId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (count === 0) throw archived('project');
    const project = await this.prisma.client.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    return toProjectDto(project, grant.role);
  }

  /** Makes an archived project writable again (owner, idempotent). */
  async restore(actor: Actor, projectId: string): Promise<ProjectDto> {
    const grant = await this.access.require(actor, projectId, 'owner');
    await this.prisma.client.project.updateMany({
      where: { id: projectId, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    const project = await this.prisma.client.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    return toProjectDto(project, grant.role);
  }
}
