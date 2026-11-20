import { z } from 'zod';

import { usdAmountSchema } from './ai.js';
import { isoDateTimeSchema } from './common.js';

/**
 * Project budgets (M7 design package §3–§5, §11): a monthly limit plus optional per-content-item
 * and per-request limits; `hard` blocks, `soft` needs `acceptOverBudget: true`.
 */

export const budgetModeSchema = z.enum(['hard', 'soft']).meta({ id: 'BudgetMode' });

const limitSchema = z.object({ limitUsd: usdAmountSchema.nullable(), mode: budgetModeSchema });

export const budgetSchema = z
  .object({
    projectId: z.uuid(),
    monthly: z.object({ limitUsd: usdAmountSchema, mode: budgetModeSchema }),
    item: limitSchema,
    request: limitSchema,
    /** The current budget month (UTC calendar month). */
    periodStart: isoDateTimeSchema,
    periodEnd: isoDateTimeSchema,
    /** Ledger cost this month (reported, else estimated). */
    spentUsd: usdAmountSchema,
    /** Open reservations: work queued or running that may still cost this much. */
    reservedUsd: usdAmountSchema,
    /** Reservations of calls whose outcome is unknown (counted until resolved). */
    heldUsd: usdAmountSchema,
    /** Calls this month whose cost is unknown and not covered by a reservation. */
    unknownCalls: z.number().int(),
    /** Monthly limit − spent − reserved − held (0 when exhausted). */
    remainingUsd: usdAmountSchema,
    /** At least 80 % of the monthly budget is used or reserved. */
    warning: z.boolean(),
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'Budget' });
export type BudgetDto = z.infer<typeof budgetSchema>;

const optionalLimit = z.strictObject({
  limitUsd: usdAmountSchema.nullable(),
  mode: budgetModeSchema,
});

export const updateBudgetRequestSchema = z
  .strictObject({
    monthly: z.strictObject({ limitUsd: usdAmountSchema, mode: budgetModeSchema }).optional(),
    item: optionalLimit.optional(),
    request: optionalLimit.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one limit is required' })
  .meta({ id: 'UpdateBudgetRequest' });
export type UpdateBudgetRequest = z.output<typeof updateBudgetRequestSchema>;

/** `error.current` of `402 BUDGET_EXCEEDED` / `409 BUDGET_CONFIRMATION_REQUIRED`. */
export const budgetBreachSchema = z
  .object({
    scope: z.enum(['request', 'item', 'month']),
    mode: budgetModeSchema,
    limitUsd: usdAmountSchema,
    spentUsd: usdAmountSchema,
    requestedUsd: usdAmountSchema,
  })
  .meta({ id: 'BudgetBreach' });
export type BudgetBreachDto = z.infer<typeof budgetBreachSchema>;
