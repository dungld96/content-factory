import { HttpStatus, Injectable } from '@nestjs/common';

import {
  ApiErrorCode,
  type AddMemberRequest,
  type MemberDto,
  type ProjectRole,
} from '@acf/contracts';
import type { TransactionClient } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { normalizeEmail } from '../auth/auth.service.js';
import { ApiError } from '../common/api-error.js';
import { notFound } from '../common/domain-errors.js';
import { preconditionFailed } from '../common/http/etag.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { TransactionRunner } from '../infrastructure/transaction-runner.js';
import { ProjectAccess } from './project-access.service.js';

interface MemberRow {
  project_id: string;
  user_id: string;
  role: ProjectRole;
  created_at: Date;
  updated_at: Date;
}

const memberSelect = {
  projectId: true,
  userId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { email: true, displayName: true } },
} as const;

type MemberRecord = {
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: Date;
  updatedAt: Date;
  user: { email: string; displayName: string };
};

function toMemberDto(m: MemberRecord): MemberDto {
  return {
    projectId: m.projectId,
    userId: m.userId,
    email: m.user.email,
    displayName: m.user.displayName,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

const lastOwner = () =>
  new ApiError({
    status: HttpStatus.CONFLICT,
    code: ApiErrorCode.LastOwner,
    message: 'A project must keep at least one owner.',
  });

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TransactionRunner,
    private readonly access: ProjectAccess,
  ) {}

  async list(actor: Actor, projectId: string): Promise<{ data: MemberDto[] }> {
    await this.access.require(actor, projectId, 'viewer');
    const members = await this.prisma.client.projectMember.findMany({
      where: { projectId },
      select: memberSelect,
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    });
    return { data: members.map(toMemberDto) };
  }

  /** Adds an existing, active user by email (owner). */
  async add(actor: Actor, projectId: string, input: AddMemberRequest): Promise<MemberDto> {
    await this.access.require(actor, projectId, 'owner', { mutation: true });
    const user = await this.prisma.client.user.findUnique({
      where: { email: normalizeEmail(input.email) },
      select: { id: true, status: true },
    });
    if (user?.status !== 'active') {
      throw new ApiError({
        status: HttpStatus.NOT_FOUND,
        code: ApiErrorCode.UserNotFound,
        message: 'No active user has this email.',
      });
    }
    const existing = await this.prisma.client.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
      select: { userId: true },
    });
    if (existing) {
      throw new ApiError({
        status: HttpStatus.CONFLICT,
        code: ApiErrorCode.AlreadyMember,
        message: 'The user is already a member of this project.',
      });
    }
    const member = await this.prisma.client.projectMember.create({
      data: { projectId, userId: user.id, role: input.role, addedById: actor.userId },
      select: memberSelect,
    });
    return toMemberDto(member);
  }

  /** Changes a member's role (owner). Enforces the last-owner rule (design package §7). */
  async updateRole(
    actor: Actor,
    projectId: string,
    userId: string,
    role: ProjectRole,
    expected: Date | undefined,
  ): Promise<MemberDto> {
    await this.access.require(actor, projectId, 'owner', { mutation: true });
    await this.tx.run('member.update_role', async (tx) => {
      const rows = await tx.$queryRaw<MemberRow[]>`
        UPDATE project_members SET role = ${role}::project_role, updated_at = now()
         WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid
           AND (${expected ?? null}::timestamptz IS NULL OR updated_at = ${expected ?? null}::timestamptz)
        RETURNING project_id, user_id, role, created_at, updated_at`;
      if (rows.length === 0) await this.explainMissing(tx, projectId, userId);
      await this.assertOwnerRemains(tx, projectId);
    });
    const member = await this.prisma.client.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId } },
      select: memberSelect,
    });
    return toMemberDto(member);
  }

  /** Removes a member (owner). Enforces the last-owner rule. */
  async remove(actor: Actor, projectId: string, userId: string): Promise<void> {
    await this.access.require(actor, projectId, 'owner', { mutation: true });
    await this.tx.run('member.remove', async (tx) => {
      const deleted = await tx.$executeRaw`
        DELETE FROM project_members WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid`;
      if (deleted === 0) throw notFound('member');
      await this.assertOwnerRemains(tx, projectId);
    });
  }

  /**
   * Lock order member → project (ADR-0011 §5): the member row is already locked by the
   * UPDATE/DELETE; the no-op write of the project row serializes owner changes of this project
   * (and makes REPEATABLE READ fail with 40001 rather than trust a stale count). The deferred
   * trigger re-checks at COMMIT (AC007).
   */
  private async assertOwnerRemains(tx: TransactionClient, projectId: string): Promise<void> {
    await tx.$executeRaw`UPDATE projects SET updated_at = updated_at WHERE id = ${projectId}::uuid`;
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_members
       WHERE project_id = ${projectId}::uuid AND role = 'owner'`;
    if (!row || row.n === 0) throw lastOwner();
  }

  private async explainMissing(
    tx: TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<never> {
    const exists = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { userId: true },
    });
    throw exists ? preconditionFailed() : notFound('member');
  }
}
