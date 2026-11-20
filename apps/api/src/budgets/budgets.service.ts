import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import { UsdAmount } from '@acf/ai-core';
import { usdFromDecimal } from '@acf/ai-runtime';
import type { ApiEnv } from '@acf/config';
import {
  ApiErrorCode,
  type BudgetBreachDto,
  type BudgetDto,
  type UpdateBudgetRequest,
} from '@acf/contracts';
import {
  BUDGET_WARNING_RATIO,
  budgetMonth,
  findBudgetBreach,
  reservationAmount,
  type BudgetLimits,
  type BudgetUsage,
} from '@acf/content-domain';
import type { Prisma, ProjectBudget, TransactionClient } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

/** One job's share of a request: its estimate (null = unknown) and how many calls it may make. */
export interface ReservationRequest {
  readonly jobId: string;
  readonly estimate: UsdAmount | null;
  readonly calls?: number;
}

const dec = (v: UsdAmount) => v.toString();
const usd = (v: Prisma.Decimal | null | undefined): UsdAmount | null =>
  v === null || v === undefined ? null : usdFromDecimal(v);

/**
 * Budgets and reservations (M7 design §3–§5). Reservations are written in the caller's
 * transaction, after its jobs, under a row lock on the project's budget: two concurrent requests
 * cannot together exceed it, and a refused request leaves nothing queued.
 */
@Injectable()
export class BudgetsService {
  private readonly logger = new Logger(BudgetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Checks the request against every limit and reserves its cost. Throws `402 BUDGET_EXCEEDED`
   * (hard) or `409 BUDGET_CONFIRMATION_REQUIRED` (soft, unless accepted).
   */
  async reserve(
    tx: TransactionClient,
    input: {
      readonly actorId: string;
      readonly projectId: string;
      readonly contentItemId: string;
      readonly jobs: readonly ReservationRequest[];
      readonly acceptOverBudget?: boolean | undefined;
    },
  ): Promise<void> {
    if (input.jobs.length === 0) return;
    const budget = await this.lock(tx, input.projectId);
    const planned = input.jobs.map((j) => ({
      ...j,
      ...reservationAmount(j.estimate, j.calls ?? 1),
    }));
    const requested = UsdAmount.sum(planned.map((p) => p.amount));
    const usage = await this.usage(tx, input.projectId, input.contentItemId, new Date());
    const breach = findBudgetBreach(limitsOf(budget), usage.limits, requested);
    if (breach) {
      const current: BudgetBreachDto = {
        scope: breach.scope,
        mode: breach.mode,
        limitUsd: dec(breach.limit),
        spentUsd: dec(breach.spent),
        requestedUsd: dec(breach.requested),
      };
      if (breach.mode === 'hard' || !input.acceptOverBudget) {
        this.logger.warn({ msg: 'budget_exceeded', projectId: input.projectId, ...current });
        throw new ApiError({
          status: breach.mode === 'hard' ? HttpStatus.PAYMENT_REQUIRED : HttpStatus.CONFLICT,
          code:
            breach.mode === 'hard'
              ? ApiErrorCode.BudgetExceeded
              : ApiErrorCode.BudgetConfirmationRequired,
          message: breachMessage(current),
          current,
        });
      }
      await tx.budgetEvent.create({
        data: {
          projectId: input.projectId,
          actorId: input.actorId,
          type: 'override',
          detail: current,
        },
      });
    }
    await tx.budgetReservation.createMany({
      data: planned.map((p) => ({
        projectId: input.projectId,
        contentItemId: input.contentItemId,
        jobId: p.jobId,
        amountUsd: dec(p.amount),
        kind: p.kind,
      })),
    });
    const monthly = usd(budget.monthlyLimitUsd) ?? UsdAmount.ZERO;
    const after = usage.limits.month.add(requested);
    if (atWarning(after, monthly)) {
      this.logger.warn({
        msg: 'budget_threshold',
        projectId: input.projectId,
        usedUsd: dec(after),
        limitUsd: dec(monthly),
      });
    }
  }

  /** The per-request limit shown with estimates (null = none). Reads; creates nothing. */
  async requestLimit(projectId: string): Promise<string | null> {
    const row = await this.prisma.client.projectBudget.findUnique({ where: { projectId } });
    if (!row) return UsdAmount.parse(this.env.DEFAULT_REQUEST_BUDGET_USD).toString();
    return usd(row.requestLimitUsd)?.toString() ?? null;
  }

  async get(actor: Actor, projectId: string): Promise<BudgetDto> {
    await this.access.require(actor, projectId, 'viewer');
    return this.toDto(projectId);
  }

  async update(actor: Actor, projectId: string, input: UpdateBudgetRequest): Promise<BudgetDto> {
    await this.access.require(actor, projectId, 'owner', { mutation: true });
    await this.prisma.client.$transaction(async (tx) => {
      const before = await this.lock(tx, projectId);
      const data: Prisma.ProjectBudgetUncheckedUpdateInput = { updatedById: actor.userId };
      if (input.monthly) {
        data.monthlyLimitUsd = input.monthly.limitUsd;
        data.monthlyMode = input.monthly.mode;
      }
      if (input.item) {
        data.itemLimitUsd = input.item.limitUsd;
        data.itemMode = input.item.mode;
      }
      if (input.request) {
        data.requestLimitUsd = input.request.limitUsd;
        data.requestMode = input.request.mode;
      }
      const after = await tx.projectBudget.update({ where: { projectId }, data });
      await tx.budgetEvent.create({
        data: {
          projectId,
          actorId: actor.userId,
          type: 'changed',
          detail: { before: limitsJson(before), after: limitsJson(after) },
        },
      });
    });
    return this.toDto(projectId);
  }

  /** The project's budget row, created with the defaults on first use, locked FOR UPDATE. */
  private async lock(tx: TransactionClient, projectId: string): Promise<ProjectBudget> {
    await tx.projectBudget.upsert({
      where: { projectId },
      create: {
        projectId,
        monthlyLimitUsd: this.env.DEFAULT_MONTHLY_BUDGET_USD,
        monthlyMode: 'hard',
        itemLimitUsd: this.env.DEFAULT_ITEM_BUDGET_USD,
        itemMode: 'soft',
        requestLimitUsd: this.env.DEFAULT_REQUEST_BUDGET_USD,
        requestMode: 'hard',
      },
      update: {},
    });
    await tx.$queryRaw`SELECT 1 FROM project_budgets WHERE project_id = ${projectId}::uuid FOR UPDATE`;
    return tx.projectBudget.findUniqueOrThrow({ where: { projectId } });
  }

  /**
   * What counts against the limits (§3.3): ledger costs (reported, else estimated) of calls not
   * covered by an open or held reservation, plus open and held reservations.
   */
  private async usage(
    db: TransactionClient | PrismaService['client'],
    projectId: string,
    contentItemId: string | null,
    at: Date,
  ): Promise<{
    limits: BudgetUsage;
    spent: UsdAmount;
    reserved: UsdAmount;
    held: UsdAmount;
    unknownCalls: number;
    period: { start: Date; end: Date };
  }> {
    const period = budgetMonth(at);
    const ledger = await db.$queryRaw<{ spent: Prisma.Decimal | null; unknown_calls: bigint }[]>`
      SELECT COALESCE(SUM(CASE
               WHEN i.cost_status = 'reported' THEN i.reported_cost
               WHEN i.cost_status = 'estimated' THEN i.estimated_cost
               ELSE 0 END), 0) AS spent,
             COUNT(*) FILTER (WHERE i.cost_status = 'unknown') AS unknown_calls
      FROM ai_invocations i
      LEFT JOIN budget_reservations r ON r.job_id = i.generation_job_id
      WHERE i.project_id = ${projectId}::uuid
        AND i.started_at >= ${period.start} AND i.started_at < ${period.end}
        AND (r.id IS NULL OR r.status IN ('settled', 'released'))`;
    const reservations = await db.$queryRaw<{ status: string; amount: Prisma.Decimal | null }[]>`
      SELECT status::text AS status, SUM(amount_usd) AS amount FROM budget_reservations
      WHERE project_id = ${projectId}::uuid AND status IN ('open', 'held') GROUP BY status`;
    const spent = usd(ledger[0]?.spent) ?? UsdAmount.ZERO;
    const reserved = usd(reservations.find((r) => r.status === 'open')?.amount) ?? UsdAmount.ZERO;
    const held = usd(reservations.find((r) => r.status === 'held')?.amount) ?? UsdAmount.ZERO;
    let item = UsdAmount.ZERO;
    if (contentItemId) {
      const rows = await db.$queryRaw<{ spent: Prisma.Decimal | null }[]>`
        SELECT (
          SELECT COALESCE(SUM(CASE
                   WHEN i.cost_status = 'reported' THEN i.reported_cost
                   WHEN i.cost_status = 'estimated' THEN i.estimated_cost
                   ELSE 0 END), 0)
          FROM ai_invocations i
          LEFT JOIN budget_reservations r ON r.job_id = i.generation_job_id
          WHERE i.content_item_id = ${contentItemId}::uuid
            AND (r.id IS NULL OR r.status IN ('settled', 'released'))
        ) + (
          SELECT COALESCE(SUM(amount_usd), 0) FROM budget_reservations
          WHERE content_item_id = ${contentItemId}::uuid AND status IN ('open', 'held')
        ) AS spent`;
      item = usd(rows[0]?.spent) ?? UsdAmount.ZERO;
    }
    return {
      limits: { month: spent.add(reserved).add(held), item },
      spent,
      reserved,
      held,
      unknownCalls: Number(ledger[0]?.unknown_calls ?? 0),
      period,
    };
  }

  private async toDto(projectId: string): Promise<BudgetDto> {
    const budget = await this.prisma.client.$transaction((tx) => this.lock(tx, projectId));
    const u = await this.usage(this.prisma.client, projectId, null, new Date());
    const monthly = usd(budget.monthlyLimitUsd) ?? UsdAmount.ZERO;
    const used = u.limits.month;
    const remaining = monthly.minusOrZero(used);
    return {
      projectId,
      monthly: { limitUsd: dec(monthly), mode: budget.monthlyMode },
      item: { limitUsd: usd(budget.itemLimitUsd)?.toString() ?? null, mode: budget.itemMode },
      request: {
        limitUsd: usd(budget.requestLimitUsd)?.toString() ?? null,
        mode: budget.requestMode,
      },
      periodStart: u.period.start.toISOString(),
      periodEnd: u.period.end.toISOString(),
      spentUsd: dec(u.spent),
      reservedUsd: dec(u.reserved),
      heldUsd: dec(u.held),
      unknownCalls: u.unknownCalls,
      remainingUsd: dec(remaining),
      warning: atWarning(used, monthly),
      updatedAt: budget.updatedAt.toISOString(),
    };
  }
}

function limitsOf(b: ProjectBudget): BudgetLimits {
  return {
    monthlyLimit: usd(b.monthlyLimitUsd) ?? UsdAmount.ZERO,
    monthlyMode: b.monthlyMode,
    itemLimit: usd(b.itemLimitUsd),
    itemMode: b.itemMode,
    requestLimit: usd(b.requestLimitUsd),
    requestMode: b.requestMode,
  };
}

function limitsJson(b: ProjectBudget): Prisma.InputJsonObject {
  return {
    monthlyLimitUsd: b.monthlyLimitUsd.toString(),
    monthlyMode: b.monthlyMode,
    itemLimitUsd: b.itemLimitUsd?.toString() ?? null,
    itemMode: b.itemMode,
    requestLimitUsd: b.requestLimitUsd?.toString() ?? null,
    requestMode: b.requestMode,
  };
}

/** True once `used` reaches the warning share of a non-zero limit (exact, B8). */
function atWarning(used: UsdAmount, limit: UsdAmount): boolean {
  return (
    !limit.isZero() &&
    used.times(100).compare(limit.times(Math.round(BUDGET_WARNING_RATIO * 100))) >= 0
  );
}

const SCOPE_TEXT: Readonly<Record<BudgetBreachDto['scope'], string>> = {
  request: 'the per-request budget',
  item: "this content item's budget",
  month: "the project's monthly budget",
};

function breachMessage(b: BudgetBreachDto): string {
  const base = `This request (about $${b.requestedUsd}) would exceed ${SCOPE_TEXT[b.scope]} of $${b.limitUsd} ($${b.spentUsd} already used or reserved).`;
  return b.mode === 'hard'
    ? `${base} Ask a project owner to raise the budget, or generate less at once.`
    : `${base} Confirm to proceed anyway.`;
}
