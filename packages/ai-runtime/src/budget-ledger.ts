import { UsdAmount } from '@acf/ai-core';
import {
  budgetMonth,
  findBudgetBreach,
  type BudgetBreach,
  type BudgetLimits,
  type BudgetUsage,
} from '@acf/content-domain';
import type { Prisma, PrismaClient, ProjectBudget, TransactionClient } from '@acf/database';

import { usdFromDecimal } from './money.js';

/**
 * Budget bookkeeping shared by the API (reserve at request time) and the worker (re-check before
 * the paid call, settle at the end): M7 design §3–§5. Everything here runs inside the caller's
 * transaction.
 */

type Db = TransactionClient | PrismaClient;

export interface BudgetDefaults {
  readonly monthlyUsd: string;
  readonly itemUsd: string;
  readonly requestUsd: string;
}

export interface BudgetUsageReport {
  /** What counts against the limits (see {@link budgetUsage}). */
  readonly limits: BudgetUsage;
  /** Ledger cost this month of calls not covered by an open or held reservation. */
  readonly spent: UsdAmount;
  readonly reserved: UsdAmount;
  readonly held: UsdAmount;
  /** Calls this month with unknown cost and no open or held reservation covering them. */
  readonly unknownCalls: number;
  readonly period: { readonly start: Date; readonly end: Date };
}

const usd = (v: Prisma.Decimal | null | undefined): UsdAmount | null =>
  v === null || v === undefined ? null : usdFromDecimal(v);

export function budgetLimitsOf(b: ProjectBudget): BudgetLimits {
  return {
    monthlyLimit: usd(b.monthlyLimitUsd) ?? UsdAmount.ZERO,
    monthlyMode: b.monthlyMode,
    itemLimit: usd(b.itemLimitUsd),
    itemMode: b.itemMode,
    requestLimit: usd(b.requestLimitUsd),
    requestMode: b.requestMode,
  };
}

/** The project's budget row, created with the defaults on first use, locked `FOR UPDATE`. */
export async function lockProjectBudget(
  tx: TransactionClient,
  projectId: string,
  defaults: BudgetDefaults,
): Promise<ProjectBudget> {
  await tx.projectBudget.upsert({
    where: { projectId },
    create: {
      projectId,
      monthlyLimitUsd: defaults.monthlyUsd,
      monthlyMode: 'hard',
      itemLimitUsd: defaults.itemUsd,
      itemMode: 'soft',
      requestLimitUsd: defaults.requestUsd,
      requestMode: 'hard',
    },
    update: {},
  });
  await tx.$queryRaw`SELECT 1 FROM project_budgets WHERE project_id = ${projectId}::uuid FOR UPDATE`;
  return tx.projectBudget.findUniqueOrThrow({ where: { projectId } });
}

/**
 * What counts against the limits (§3.3): ledger costs (reported, else estimated) of calls not
 * covered by an open or held reservation, plus open and held reservations. `excludeJobId` leaves
 * one job's reservation out (the worker re-checks whether that job still fits).
 */
export async function budgetUsage(
  db: Db,
  projectId: string,
  contentItemId: string | null,
  at: Date,
  excludeJobId: string | null = null,
): Promise<BudgetUsageReport> {
  const period = budgetMonth(at);
  const exclude = excludeJobId ?? '00000000-0000-0000-0000-000000000000';
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
    WHERE project_id = ${projectId}::uuid AND status IN ('open', 'held')
      AND job_id <> ${exclude}::uuid
    GROUP BY status`;
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
          AND job_id <> ${exclude}::uuid
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

/**
 * Worker re-check right before a job's paid call (B4): does the job's own reservation still fit
 * the budget as it is now? Only hard limits block here (a soft limit was accepted when the work
 * was requested). Null when it fits or the job has no open reservation (unpaid, or pre-M7).
 */
export async function recheckJobBudget(
  tx: TransactionClient,
  job: { readonly id: string; readonly projectId: string; readonly contentItemId: string },
  at = new Date(),
): Promise<BudgetBreach | null> {
  const reservation = await tx.budgetReservation.findUnique({ where: { jobId: job.id } });
  if (reservation?.status !== 'open') return null;
  await tx.$queryRaw`SELECT 1 FROM project_budgets WHERE project_id = ${job.projectId}::uuid FOR UPDATE`;
  const budget = await tx.projectBudget.findUnique({ where: { projectId: job.projectId } });
  if (!budget) return null;
  const usage = await budgetUsage(tx, job.projectId, job.contentItemId, at, job.id);
  const breach = findBudgetBreach(
    budgetLimitsOf(budget),
    usage.limits,
    usdFromDecimal(reservation.amountUsd),
  );
  return breach?.mode === 'hard' ? breach : null;
}

export type ReservationOutcome = 'settled' | 'released' | 'held';

/**
 * Resolves a job's open reservation (§4): `settled` once its calls are in the ledger, `released`
 * when nothing was or will be charged, `held` when the outcome is unknown (keeps counting until
 * an operator resolves it). A held reservation may later be settled or released. Returns the
 * outcome applied, or null when the job has no reservation in a state that can move.
 */
export async function resolveReservation(
  tx: TransactionClient,
  jobId: string,
  to: ReservationOutcome,
): Promise<ReservationOutcome | null> {
  const from = to === 'held' ? ['open' as const] : (['open', 'held'] as const);
  const { count } = await tx.budgetReservation.updateMany({
    where: { jobId, status: { in: [...from] } },
    data: { status: to, resolvedAt: to === 'held' ? null : new Date() },
  });
  return count === 1 ? to : null;
}

/** The reservation outcome of a job that ended with `errorCode` (null = succeeded). */
export function reservationOutcomeFor(errorCode: string | null): ReservationOutcome {
  if (errorCode === null) return 'settled';
  return HELD_ERROR_CODES.has(errorCode) ? 'held' : 'released';
}

/** Job endings whose provider charge is unknown: the reservation keeps counting. */
const HELD_ERROR_CODES: ReadonlySet<string> = new Set(['SUBMIT_OUTCOME_UNKNOWN']);
