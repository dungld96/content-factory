import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  heldReservationSchema,
  opsSummarySchema,
  projectCostsQuerySchema,
  projectCostsSchema,
  projectIdParamsSchema,
  reservationIdParamsSchema,
  resolveReservationRequestSchema,
  type HeldReservationDto,
  type OpsSummaryDto,
  type ProjectCostsDto,
  type ResolveReservationRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { CostsService } from './costs.service.js';
import { OpsService } from './ops.service.js';

type ReservationParams = z.infer<typeof reservationIdParamsSchema>;
type ProjectParams = z.infer<typeof projectIdParamsSchema>;

/** Operations page and cost dashboard (M7 design package §8, §9, §11). */
@Controller()
export class OperationsController {
  constructor(
    private readonly ops: OpsService,
    private readonly costs: CostsService,
  ) {}

  @Get('ops/summary')
  @Endpoint({
    summary: 'Queues, recent jobs, failures, provider circuits, budgets and held reservations',
    tags: ['operations'],
    responses: {
      200: {
        description: 'Summary (project data of your projects only)',
        schema: opsSummarySchema,
      },
    },
    errors: [401],
  })
  summary(@CurrentActor() actor: Actor): Promise<OpsSummaryDto> {
    return this.ops.summary(actor);
  }

  @Post('ops/reservations/:reservationId/settle')
  @HttpCode(200)
  @Endpoint({
    summary: 'Owner: the provider charged a held reservation (its amount stays counted)',
    tags: ['operations'],
    params: reservationIdParamsSchema,
    body: resolveReservationRequestSchema,
    responses: { 200: { description: 'The reservation', schema: heldReservationSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  settle(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ReservationParams,
    @ValidBody() body: ResolveReservationRequest,
  ): Promise<HeldReservationDto> {
    return this.ops.resolve(actor, params.reservationId, 'settled', body);
  }

  @Post('ops/reservations/:reservationId/release')
  @HttpCode(200)
  @Endpoint({
    summary: 'Owner: the provider did not charge a held reservation',
    tags: ['operations'],
    params: reservationIdParamsSchema,
    body: resolveReservationRequestSchema,
    responses: { 200: { description: 'The reservation', schema: heldReservationSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  release(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ReservationParams,
    @ValidBody() body: ResolveReservationRequest,
  ): Promise<HeldReservationDto> {
    return this.ops.resolve(actor, params.reservationId, 'released', body);
  }

  @Get('projects/:projectId/costs')
  @Endpoint({
    summary: 'Cost dashboard of a project for a UTC month (default: this month)',
    tags: ['operations'],
    params: projectIdParamsSchema,
    query: projectCostsQuerySchema,
    responses: { 200: { description: 'Costs', schema: projectCostsSchema } },
    errors: [400, 401, 404],
  })
  projectCosts(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: z.infer<typeof projectCostsQuerySchema>,
  ): Promise<ProjectCostsDto> {
    return this.costs.projectCosts(actor, params.projectId, query.month);
  }
}
