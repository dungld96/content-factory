import { Injectable } from '@nestjs/common';

import type { ProjectRole } from '@acf/contracts';
import type { TransactionClient } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { archived, forbidden, notFound } from '../common/domain-errors.js';
import { PrismaService } from '../infrastructure/prisma.service.js';

const RANK: Readonly<Record<ProjectRole, number>> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export interface ProjectAccessGrant {
  readonly projectId: string;
  readonly role: ProjectRole;
  readonly projectArchivedAt: Date | null;
}

export interface RequireOptions {
  /** The action changes data: an archived project is read-only (409 ARCHIVED). */
  readonly mutation?: boolean;
  /** Run inside this transaction instead of the shared client. */
  readonly tx?: TransactionClient;
}

/**
 * Project-level RBAC, enforced in services (ADR-0009 requirement 4; design package §8.1).
 * Roles are read from the database on every call, so changes apply immediately.
 */
@Injectable()
export class ProjectAccess {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @throws 404 if the project does not exist or the actor is not a member (indistinguishable,
   *   decision D7), 403 if the role is below `minimum`, 409 ARCHIVED for a mutation of an
   *   archived project.
   */
  async require(
    actor: Actor,
    projectId: string,
    minimum: ProjectRole,
    options: RequireOptions = {},
  ): Promise<ProjectAccessGrant> {
    const db = options.tx ?? this.prisma.client;
    const membership = await db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: actor.userId } },
      select: { role: true, project: { select: { archivedAt: true } } },
    });
    if (!membership) throw notFound('project');
    if (!roleAtLeast(membership.role, minimum)) throw forbidden();
    if (options.mutation && membership.project.archivedAt) throw archived('project');
    return {
      projectId,
      role: membership.role,
      projectArchivedAt: membership.project.archivedAt,
    };
  }
}
