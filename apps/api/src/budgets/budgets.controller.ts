import { Controller, Get, Put } from '@nestjs/common';
import type { z } from 'zod';

import {
  budgetSchema,
  projectIdParamsSchema,
  updateBudgetRequestSchema,
  type BudgetDto,
  type UpdateBudgetRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams } from '../common/http/endpoint.js';
import { BudgetsService } from './budgets.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
const tags = ['budgets'];

/** Project budgets (M7 design package §3, §11). */
@Controller('projects/:projectId/budget')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @Endpoint({
    summary: "The project's budget limits and this month's usage",
    tags,
    params: projectIdParamsSchema,
    responses: { 200: { description: 'Budget', schema: budgetSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: ProjectParams): Promise<BudgetDto> {
    return this.budgets.get(actor, params.projectId);
  }

  @Put()
  @Endpoint({
    summary: 'Change budget limits (owner); recorded as a budget event',
    tags,
    params: projectIdParamsSchema,
    body: updateBudgetRequestSchema,
    responses: { 200: { description: 'Budget', schema: budgetSchema } },
    errors: [400, 401, 403, 404],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: UpdateBudgetRequest,
  ): Promise<BudgetDto> {
    return this.budgets.update(actor, params.projectId, body);
  }
}
