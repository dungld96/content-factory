import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthStatus, type LivenessResponse, type ReadinessResponse } from '@acf/contracts';

import { HealthService } from './health.service.js';

/** Health endpoints are intentionally unauthenticated (docs/API_SPEC.md). */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is running. Never touches dependencies. */
  @Get()
  live(): LivenessResponse {
    return this.health.liveness();
  }

  /** Readiness: PostgreSQL and Redis reachable. Returns 503 when any check fails. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    res.status(result.status === HealthStatus.Ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    res.setHeader('Cache-Control', 'no-store');
    return result;
  }
}
