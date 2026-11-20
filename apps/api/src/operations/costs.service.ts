import { Inject, Injectable } from '@nestjs/common';

import { UsdAmount } from '@acf/ai-core';
import { usdFromDecimal } from '@acf/ai-runtime';
import type { ApiEnv } from '@acf/config';
import { BUDGET_WARNING_RATIO, budgetMonth } from '@acf/content-domain';
import type { CostFigureDto, ProjectCostsDto } from '@acf/contracts';
import type { GenerationJobKind, Prisma } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

/** One ledger group: calls of a content item, stage and model, split by whether they produced the result. */
interface LedgerRow {
  content_item_id: string | null;
  kind: GenerationJobKind | null;
  provider_key: string;
  model_key: string;
  wasted: boolean;
  calls: bigint;
  reported: Prisma.Decimal | null;
  estimated: Prisma.Decimal | null;
  unknown: bigint;
}

interface HeldRow {
  content_item_id: string;
  kind: GenerationJobKind;
  provider_key: string;
  model_key: string;
  /** True: a charge an owner confirmed when settling a held reservation (counted as estimated). */
  settled: boolean;
  amount: Prisma.Decimal | null;
}

/** Mutable sum of a {@link CostFigureDto}. */
class Figure {
  calls = 0;
  reported = UsdAmount.ZERO;
  estimated = UsdAmount.ZERO;
  unknownCalls = 0;
  held = UsdAmount.ZERO;

  addLedger(r: LedgerRow): void {
    this.calls += Number(r.calls);
    this.reported = this.reported.add(dec(r.reported));
    this.estimated = this.estimated.add(dec(r.estimated));
    this.unknownCalls += Number(r.unknown);
  }

  addHeld(r: HeldRow): void {
    if (r.settled) this.estimated = this.estimated.add(dec(r.amount));
    else this.held = this.held.add(dec(r.amount));
  }

  total(): UsdAmount {
    return this.reported.add(this.estimated).add(this.held);
  }

  dto(): CostFigureDto {
    return {
      calls: this.calls,
      reportedUsd: this.reported.toString(),
      estimatedUsd: this.estimated.toString(),
      unknownCalls: this.unknownCalls,
      heldUsd: this.held.toString(),
      totalUsd: this.total().toString(),
    };
  }
}

const dec = (v: Prisma.Decimal | null): UsdAmount =>
  v === null ? UsdAmount.ZERO : usdFromDecimal(v);

function group<K>(map: Map<K, Figure>, key: K): Figure {
  let f = map.get(key);
  if (!f) {
    f = new Figure();
    map.set(key, f);
  }
  return f;
}

const monthKey = (d: Date) =>
  `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Cost dashboard of a project (M7 design §9, B9). Ledger costs (reported, else estimated) of the
 * month's calls, plus held reservations (outcome unknown) instead of the ledger rows they cover,
 * so nothing is counted twice. Unknown-cost calls are counted, never priced at zero.
 */
@Injectable()
export class CostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async projectCosts(
    actor: Actor,
    projectId: string,
    month: string | undefined,
  ): Promise<ProjectCostsDto> {
    await this.access.require(actor, projectId, 'viewer');
    const at = month ? new Date(`${month}-01T00:00:00Z`) : new Date();
    const period = budgetMonth(at);
    const [ledger, held] = await Promise.all([
      this.ledger(projectId, period.start, period.end),
      this.held(projectId, period.start, period.end),
    ]);

    const total = new Figure();
    const retry = new Figure();
    const byItem = new Map<string, Figure>();
    const byStage = new Map<GenerationJobKind, Figure>();
    const byModel = new Map<string, Figure>();
    for (const r of ledger) {
      total.addLedger(r);
      if (r.wasted) retry.addLedger(r);
      if (r.content_item_id) group(byItem, r.content_item_id).addLedger(r);
      if (r.kind) group(byStage, r.kind).addLedger(r);
      group(byModel, `${r.provider_key}\u0000${r.model_key}`).addLedger(r);
    }
    for (const h of held) {
      total.addHeld(h);
      group(byItem, h.content_item_id).addHeld(h);
      group(byStage, h.kind).addHeld(h);
      group(byModel, `${h.provider_key}\u0000${h.model_key}`).addHeld(h);
    }

    const titles = new Map(
      (
        await this.prisma.client.contentItem.findMany({
          where: { id: { in: [...byItem.keys()] } },
          select: { id: true, title: true },
        })
      ).map((c) => [c.id, c.title]),
    );
    const budget = await this.prisma.client.projectBudget.findUnique({ where: { projectId } });
    const limit = budget
      ? usdFromDecimal(budget.monthlyLimitUsd)
      : UsdAmount.parse(this.env.DEFAULT_MONTHLY_BUDGET_USD);

    const trend: ProjectCostsDto['trend'] = [];
    for (let back = 5; back >= 0; back -= 1) {
      const start = new Date(
        Date.UTC(period.start.getUTCFullYear(), period.start.getUTCMonth() - back, 1),
      );
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const f = new Figure();
      if (back === 0) {
        trend.push({ month: monthKey(start), cost: total.dto() });
        continue;
      }
      for (const r of await this.ledger(projectId, start, end)) f.addLedger(r);
      for (const h of await this.held(projectId, start, end)) f.addHeld(h);
      trend.push({ month: monthKey(start), cost: f.dto() });
    }

    return {
      projectId,
      month: monthKey(period.start),
      total: total.dto(),
      budget: {
        limitUsd: limit.toString(),
        warning:
          !limit.isZero() &&
          total
            .total()
            .times(100)
            .compare(limit.times(Math.round(BUDGET_WARNING_RATIO * 100))) >= 0,
      },
      byContentItem: [...byItem.entries()]
        .map(([id, f]) => ({ contentItemId: id, title: titles.get(id) ?? '', cost: f.dto() }))
        .sort((a, b) => UsdAmount.parse(b.cost.totalUsd).compare(UsdAmount.parse(a.cost.totalUsd))),
      byStage: [...byStage.entries()]
        .map(([kind, f]) => ({ kind, cost: f.dto() }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      byModel: [...byModel.entries()]
        .map(([key, f]) => {
          const [providerKey = '', modelKey = ''] = key.split('\u0000');
          return { providerKey, modelKey, cost: f.dto() };
        })
        .sort((a, b) =>
          `${a.providerKey}/${a.modelKey}`.localeCompare(`${b.providerKey}/${b.modelKey}`),
        ),
      retryCost: retry.dto(),
      costPerApprovedVideo: await this.perApprovedVideo(projectId, period.start, period.end),
      trend,
    };
  }

  /**
   * All-time cost of the content items whose render was approved in the month, per item. Held
   * reservations count; unknown-cost calls cannot be priced and are left out of the division.
   */
  private async perApprovedVideo(
    projectId: string,
    start: Date,
    end: Date,
  ): Promise<ProjectCostsDto['costPerApprovedVideo']> {
    const items = await this.prisma.client.contentItem.findMany({
      where: {
        projectId,
        approvedRender: { reviewedAt: { gte: start, lt: end } },
      },
      select: { id: true },
    });
    if (items.length === 0) return null;
    const ids = items.map((i) => i.id);
    const f = new Figure();
    for (const r of await this.ledger(projectId, new Date(0), new Date(8.64e15), ids))
      f.addLedger(r);
    for (const h of await this.held(projectId, new Date(0), new Date(8.64e15), ids)) f.addHeld(h);
    const perVideo = UsdAmount.fromUnits(f.total().units / BigInt(items.length));
    return { approvedVideos: items.length, perVideoUsd: perVideo.toString() };
  }

  /** Ledger groups of calls started in [start, end), without calls covered by a held reservation. */
  private ledger(
    projectId: string,
    start: Date,
    end: Date,
    itemIds?: readonly string[],
  ): Promise<LedgerRow[]> {
    const items = itemIds ?? null;
    return this.prisma.client.$queryRaw<LedgerRow[]>`
      SELECT i.content_item_id, j.kind, p.key AS provider_key, m.model_key,
             (i.status <> 'succeeded' OR (j.id IS NOT NULL AND j.status <> 'succeeded')) AS wasted,
             COUNT(*) AS calls,
             SUM(CASE WHEN i.cost_status = 'reported' THEN i.reported_cost ELSE 0 END) AS reported,
             SUM(CASE WHEN i.cost_status = 'estimated' THEN i.estimated_cost ELSE 0 END) AS estimated,
             COUNT(*) FILTER (WHERE i.cost_status = 'unknown') AS unknown
      FROM ai_invocations i
      JOIN ai_providers p ON p.id = i.provider_id
      JOIN ai_models m ON m.id = i.model_id
      LEFT JOIN generation_jobs j ON j.id = i.generation_job_id
      LEFT JOIN budget_reservations r ON r.job_id = i.generation_job_id
      WHERE i.project_id = ${projectId}::uuid
        AND i.started_at >= ${start} AND i.started_at < ${end}
        AND (r.id IS NULL OR (r.status <> 'held' AND r.settled_charge_usd IS NULL))
        AND (${items}::uuid[] IS NULL OR i.content_item_id = ANY(${items}::uuid[]))
      GROUP BY 1, 2, 3, 4, 5`;
  }

  /**
   * Held reservations created in [start, end), and the charges owners confirmed when settling
   * held reservations (`settled`).
   */
  private held(
    projectId: string,
    start: Date,
    end: Date,
    itemIds?: readonly string[],
  ): Promise<HeldRow[]> {
    const items = itemIds ?? null;
    return this.prisma.client.$queryRaw<HeldRow[]>`
      SELECT r.content_item_id, j.kind, p.key AS provider_key, m.model_key,
             (r.status = 'settled') AS settled,
             SUM(CASE WHEN r.status = 'settled' THEN r.settled_charge_usd ELSE r.amount_usd END) AS amount
      FROM budget_reservations r
      JOIN generation_jobs j ON j.id = r.job_id
      JOIN ai_models m ON m.id = j.model_id
      JOIN ai_providers p ON p.id = m.provider_id
      WHERE r.project_id = ${projectId}::uuid
        AND (r.status = 'held' OR r.settled_charge_usd IS NOT NULL)
        AND r.created_at >= ${start} AND r.created_at < ${end}
        AND (${items}::uuid[] IS NULL OR r.content_item_id = ANY(${items}::uuid[]))
      GROUP BY 1, 2, 3, 4, 5`;
  }
}
