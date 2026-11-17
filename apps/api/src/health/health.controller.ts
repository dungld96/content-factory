import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  HealthStatus,
  livenessResponseSchema,
  readinessResponseSchema,
  type LivenessResponse,
  type ReadinessResponse,
} from '@acf/contracts';

import { Public } from '../auth/public.decorator.js';
import { Endpoint } from '../common/http/endpoint.js';

import { HealthService } from './health.service.js';

/** Health endpoints are intentionally unauthenticated (docs/API_SPEC.md). */
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is running. Never touches dependencies. */
  @Get()
  @Endpoint({
    summary: 'Liveness: the process is running',
    tags: ['health'],
    responses: { 200: { description: 'Alive', schema: livenessResponseSchema } },
  })
  live(): LivenessResponse {
    return this.health.liveness();
  }

  /** Readiness: PostgreSQL and Redis reachable. Returns 503 when any check fails. */
  @Get('ready')
  @Endpoint({
    summary: 'Readiness: PostgreSQL and Redis are reachable',
    tags: ['health'],
    responses: {
      200: { description: 'All dependencies are up', schema: readinessResponseSchema },
      503: { description: 'A dependency is down', schema: readinessResponseSchema },
    },
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    res.status(result.status === HealthStatus.Ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    res.setHeader('Cache-Control', 'no-store');
    return result;
  }
}
