import { Inject, Injectable } from '@nestjs/common';

import { usdFromDecimal } from '@acf/ai-runtime';
import type { ApiEnv } from '@acf/config';
import type { SpendingSettingsDto, UpdateSpendingSettingsRequest } from '@acf/contracts';

import type { Actor } from '../auth/actor.js';
import { requireOperator } from '../auth/operator.js';
import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';

/** The workspace threshold when no settings row exists yet (redesign R-D4). */
export const DEFAULT_CONFIRM_THRESHOLD_USD = '1';

/**
 * Workspace spending settings (redesign R-D4): one row, created on the first change. Everyone
 * signed in reads it (the studio shows the threshold in confirmations); operators change it.
 */
@Injectable()
export class SpendingSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async get(): Promise<SpendingSettingsDto> {
    const row = await this.prisma.client.workspaceSettings.findUnique({ where: { id: 1 } });
    return {
      confirmThresholdUsd: row
        ? usdFromDecimal(row.confirmThresholdUsd).toString()
        : DEFAULT_CONFIRM_THRESHOLD_USD,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** The workspace threshold as a decimal string. */
  async threshold(): Promise<string> {
    return (await this.get()).confirmThresholdUsd;
  }

  async update(actor: Actor, input: UpdateSpendingSettingsRequest): Promise<SpendingSettingsDto> {
    requireOperator(this.env, actor);
    await this.prisma.client.workspaceSettings.upsert({
      where: { id: 1 },
      create: { id: 1, confirmThresholdUsd: input.confirmThresholdUsd, updatedById: actor.userId },
      update: { confirmThresholdUsd: input.confirmThresholdUsd, updatedById: actor.userId },
    });
    return this.get();
  }
}
