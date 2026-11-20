import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import { UsdAmount } from '@acf/ai-core';
import { budgetUsage, usdFromDecimal } from '@acf/ai-runtime';
import type { ApiEnv } from '@acf/config';
import { BUDGET_WARNING_RATIO } from '@acf/content-domain';
import {
  ApiErrorCode,
  type HeldReservationDto,
  type OpsSummaryDto,
  type ResolveReservationRequest,
} from '@acf/contracts';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { notFound } from '../common/domain-errors.js';
import { API_ENV } from '../config/api-config.module.js';
import { GenerationQueue } from '../generation/generation.queue.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Operations summary (M7 design §8, B8) and resolution of held reservations. Project data is
 * limited to the caller's memberships; queues and circuits are global infrastructure state
 * (counts and provider names only, nothing project-specific).
 */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly queue: GenerationQueue,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async summary(actor: Actor): Promise<OpsSummaryDto> {
    const db = this.prisma.client;
    const memberships = await db.projectMember.findMany({
      where: { userId: actor.userId, project: { archivedAt: null } },
      include: { project: { select: { id: true, name: true } } },
    });
    const projectIds = memberships.map((m) => m.projectId);
    const owned = new Set(memberships.filter((m) => m.role === 'owner').map((m) => m.projectId));
    const since = new Date(Date.now() - DAY_MS);

    const [queues, jobs24h, failed, circuits, held] = await Promise.all([
      this.queue.depths(),
      db.generationJob.groupBy({
        by: ['kind', 'status'],
        where: { projectId: { in: projectIds }, updatedAt: { gte: since } },
        _count: { _all: true },
      }),
      db.generationJob.findMany({
        where: { projectId: { in: projectIds }, status: 'failed' },
        orderBy: { completedAt: 'desc' },
        take: 50,
        include: {
          project: { select: { name: true } },
          contentItem: { select: { title: true } },
        },
      }),
      db.providerCircuit.findMany({
        include: { provider: { select: { key: true, name: true } } },
        orderBy: { provider: { key: 'asc' } },
      }),
      db.budgetReservation.findMany({
        where: { projectId: { in: projectIds }, status: 'held' },
        orderBy: { createdAt: 'asc' },
        include: {
          job: { select: { kind: true, errorCode: true } },
          contentItem: { select: { title: true, project: { select: { name: true } } } },
        },
      }),
    ]);

    const budgets: OpsSummaryDto['budgets'] = [];
    for (const m of memberships) {
      const row = await db.projectBudget.findUnique({ where: { projectId: m.projectId } });
      const limit = row
        ? usdFromDecimal(row.monthlyLimitUsd)
        : UsdAmount.parse(this.env.DEFAULT_MONTHLY_BUDGET_USD);
      const usage = await budgetUsage(db, m.projectId, null, new Date());
      const used = usage.limits.month;
      budgets.push({
        projectId: m.projectId,
        projectName: m.project.name,
        limitUsd: limit.toString(),
        usedUsd: used.toString(),
        heldUsd: usage.held.toString(),
        warning:
          !limit.isZero() &&
          used.times(100).compare(limit.times(Math.round(BUDGET_WARNING_RATIO * 100))) >= 0,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      queues,
      jobs24h: jobs24h.map((g) => ({ kind: g.kind, status: g.status, count: g._count._all })),
      failedJobs: failed.map((j) => ({
        jobId: j.id,
        kind: j.kind,
        errorCode: j.errorCode,
        errorMessage: j.errorMessage,
        attempt: j.attempt,
        projectId: j.projectId,
        projectName: j.project.name,
        contentItemId: j.contentItemId,
        contentTitle: j.contentItem.title,
        productionRunId: j.productionRunId,
        failedAt: (j.completedAt ?? j.updatedAt).toISOString(),
      })),
      circuits: circuits.map((c) => ({
        providerKey: c.provider.key,
        providerName: c.provider.name,
        state: c.state,
        consecutiveFailures: c.consecutiveFailures,
        retryAt: c.retryAt?.toISOString() ?? null,
        lastErrorCode: c.lastErrorCode,
      })),
      budgets,
      heldReservations: held.map((r): HeldReservationDto => ({
        id: r.id,
        projectId: r.projectId,
        projectName: r.contentItem.project.name,
        contentItemId: r.contentItemId,
        contentTitle: r.contentItem.title,
        jobId: r.jobId,
        jobKind: r.job.kind,
        jobErrorCode: r.job.errorCode,
        amountUsd: usdFromDecimal(r.amountUsd).toString(),
        createdAt: r.createdAt.toISOString(),
        canResolve: owned.has(r.projectId),
      })),
    };
  }

  /**
   * An owner resolves a held reservation: `settled` (the provider charged: the amount stays
   * counted as spent) or `released` (it did not charge). Recorded as a budget event.
   */
  async resolve(
    actor: Actor,
    reservationId: string,
    to: 'settled' | 'released',
    input: ResolveReservationRequest,
  ): Promise<HeldReservationDto> {
    const found = await this.prisma.client.budgetReservation.findUnique({
      where: { id: reservationId },
    });
    if (!found) throw notFound('reservation');
    await this.access.require(actor, found.projectId, 'owner', { mutation: true });
    await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.budgetReservation.findUniqueOrThrow({
        where: { id: reservationId },
      });
      if (current.status !== 'held') {
        throw new ApiError({
          status: HttpStatus.CONFLICT,
          code: ApiErrorCode.ReservationNotHeld,
          message: `This reservation is ${current.status}; only held reservations are resolved by hand.`,
          current: { status: current.status },
        });
      }
      // Settled: the provider charged. The ledger cannot price the call (outcome unknown), so the
      // reserved amount is kept as the confirmed charge and stays counted as spent.
      await tx.budgetReservation.update({
        where: { id: reservationId },
        data: {
          status: to,
          resolvedAt: new Date(),
          ...(to === 'settled' ? { settledChargeUsd: current.amountUsd } : {}),
        },
      });
      await tx.budgetEvent.create({
        data: {
          projectId: current.projectId,
          actorId: actor.userId,
          type: to,
          detail: {
            reservationId,
            jobId: current.jobId,
            amountUsd: usdFromDecimal(current.amountUsd).toString(),
            ...(input.note ? { note: input.note } : {}),
          },
        },
      });
    });
    this.logger.log({ msg: `reservation_${to}`, reservationId, actorId: actor.userId });
    const r = await this.prisma.client.budgetReservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: {
        job: { select: { kind: true, errorCode: true } },
        contentItem: { select: { title: true, project: { select: { name: true } } } },
      },
    });
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: r.contentItem.project.name,
      contentItemId: r.contentItemId,
      contentTitle: r.contentItem.title,
      jobId: r.jobId,
      jobKind: r.job.kind,
      jobErrorCode: r.job.errorCode,
      amountUsd: usdFromDecimal(r.amountUsd).toString(),
      createdAt: r.createdAt.toISOString(),
      canResolve: false,
    };
  }
}
