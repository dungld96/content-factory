import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';
import {
  HealthStatus,
  type DependencyCheck,
  type LivenessResponse,
  type ReadinessCheckName,
  type ReadinessResponse,
} from '@acf/contracts';

import { API_ENV } from '../config/api-config.module.js';

import {
  ProbeTimeoutError,
  READINESS_PROBES,
  type ReadinessProbe,
  type ReadinessProbes,
} from './readiness-probe.js';

export const SERVICE_NAME = 'acf-api';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(READINESS_PROBES) private readonly probes: ReadinessProbes,
  ) {}

  liveness(): LivenessResponse {
    return {
      status: HealthStatus.Ok,
      service: SERVICE_NAME,
      version: process.env['npm_package_version'] ?? '0.0.0',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResponse> {
    const names = Object.keys(this.probes) as ReadinessCheckName[];
    const entries = await Promise.all(
      names.map(async (name) => [name, await this.runProbe(name, this.probes[name])] as const),
    );
    const checks = Object.fromEntries(entries) as ReadinessResponse['checks'];
    const allOk = entries.every(([, check]) => check.status === HealthStatus.Ok);
    return {
      status: allOk ? HealthStatus.Ok : HealthStatus.Error,
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async runProbe(
    name: ReadinessCheckName,
    probe: ReadinessProbe,
  ): Promise<DependencyCheck> {
    const timeoutMs = this.env.HEALTH_CHECK_TIMEOUT_MS;
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ProbeTimeoutError(`timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      return { status: HealthStatus.Ok, latencyMs: elapsed(started) };
    } catch (error: unknown) {
      const timedOut = error instanceof ProbeTimeoutError;
      // Log only the error class/code: driver messages can include hosts or usernames.
      this.logger.warn({
        msg: 'readiness_probe_failed',
        check: name,
        reason: timedOut ? 'timeout' : 'unreachable',
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: extractCode(error),
      });
      return {
        status: HealthStatus.Error,
        latencyMs: elapsed(started),
        error: timedOut ? 'timeout' : 'unreachable',
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function extractCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}
