import { ProviderErrorCode } from '@acf/ai-core';
import type { CircuitState, PrismaClient, ProviderCircuit, TransactionClient } from '@acf/database';

/**
 * Circuit breaker per provider (M7 design §7, decision B7). State lives in PostgreSQL, so the API
 * and every worker see the same circuit; each change locks the provider's row.
 *
 * - closed → open after {@link CIRCUIT_POLICY.failureThreshold} counted failures in a row, each
 *   within {@link CIRCUIT_POLICY.failureWindowMs} of the previous one.
 * - open: jobs wait (they are deferred, not failed) until `retry_at`.
 * - then half-open: exactly one trial job is admitted; success closes the circuit, a counted
 *   failure reopens it for twice as long (capped). A trial that never reports back is replaced
 *   after {@link CIRCUIT_POLICY.trialTimeoutMs}.
 */
export const CIRCUIT_POLICY = {
  failureThreshold: 5,
  failureWindowMs: 10 * 60_000,
  openForMs: 5 * 60_000,
  maxOpenForMs: 30 * 60_000,
  trialTimeoutMs: 10 * 60_000,
  /** How long a job may wait for its provider's circuit before it fails (PROVIDER_UNAVAILABLE). */
  maxWaitMs: 2 * 60 * 60_000,
  /** Delay before a job waiting on another job's trial checks again. */
  trialWaitMs: 30_000,
} as const;

/**
 * Failures that say the provider itself is unhealthy. Invalid requests, policy blocks,
 * authentication, credits, budget blocks and rate limits (handled by backoff) are not counted.
 */
const COUNTED: ReadonlySet<string> = new Set<string>([
  ProviderErrorCode.TIMEOUT,
  ProviderErrorCode.PROVIDER_UNAVAILABLE,
  ProviderErrorCode.NETWORK,
  ProviderErrorCode.PROVIDER_ERROR,
]);

export function countsForCircuit(errorCode: string): boolean {
  return COUNTED.has(errorCode);
}

export type CircuitAdmission =
  { readonly admitted: true } | { readonly admitted: false; readonly retryInMs: number };

export interface CircuitTransition {
  readonly providerId: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly reason: string;
  readonly errorCode: string | null;
  readonly jobId: string | null;
}

export interface CircuitBreakerOptions {
  /** Called after each committed transition (the worker logs `circuit_opened` / `circuit_closed`). */
  readonly onTransition?: (t: CircuitTransition) => void;
  readonly now?: () => Date;
}

export class CircuitBreaker {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: CircuitBreakerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** May this job call the provider now? Half-open admits only the trial job. */
  async admit(providerId: string, jobId: string): Promise<CircuitAdmission> {
    const done: CircuitTransition[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, providerId);
      const now = this.now();
      if (c.state === 'closed') return { admitted: true } as const;
      if (c.state === 'open') {
        const wait = (c.retryAt?.getTime() ?? 0) - now.getTime();
        if (wait > 0) return { admitted: false, retryInMs: wait } as const;
        await this.move(tx, c, 'half_open', 'trial', null, jobId, done, {
          trialJobId: jobId,
          trialStartedAt: now,
        });
        return { admitted: true } as const;
      }
      // half-open
      if (c.trialJobId === jobId) return { admitted: true } as const;
      const trialAge = now.getTime() - (c.trialStartedAt?.getTime() ?? 0);
      if (trialAge >= CIRCUIT_POLICY.trialTimeoutMs) {
        await this.move(tx, c, 'half_open', 'trial_expired', null, jobId, done, {
          trialJobId: jobId,
          trialStartedAt: now,
        });
        return { admitted: true } as const;
      }
      return { admitted: false, retryInMs: CIRCUIT_POLICY.trialWaitMs } as const;
    });
    this.emit(done);
    return result;
  }

  /** A call succeeded (or failed in a way that proves the provider answers). */
  async recordSuccess(providerId: string, jobId: string): Promise<void> {
    const done: CircuitTransition[] = [];
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, providerId);
      if (c.state === 'half_open' && c.trialJobId === jobId) {
        await this.move(tx, c, 'closed', 'trial_succeeded', null, jobId, done, CLOSED);
      } else if (c.state === 'closed' && c.consecutiveFailures > 0) {
        await tx.providerCircuit.update({
          where: { providerId },
          data: { consecutiveFailures: 0 },
        });
      }
    });
    this.emit(done);
  }

  /** A call failed. Only counted failures ({@link countsForCircuit}) move the circuit. */
  async recordFailure(providerId: string, jobId: string, errorCode: string): Promise<void> {
    if (!countsForCircuit(errorCode)) {
      // The provider answered: a half-open trial has proven it is reachable.
      await this.recordSuccess(providerId, jobId);
      return;
    }
    const done: CircuitTransition[] = [];
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, providerId);
      const now = this.now();
      if (c.state === 'half_open') {
        if (c.trialJobId !== jobId) return;
        const openForMs = Math.min(c.openForMs * 2, CIRCUIT_POLICY.maxOpenForMs);
        await this.move(tx, c, 'open', 'trial_failed', errorCode, jobId, done, {
          openedAt: now,
          retryAt: new Date(now.getTime() + openForMs),
          openForMs,
          trialJobId: null,
          trialStartedAt: null,
          lastErrorCode: errorCode,
          lastFailureAt: now,
        });
        return;
      }
      if (c.state === 'open') return;
      const recent =
        c.lastFailureAt !== null &&
        now.getTime() - c.lastFailureAt.getTime() <= CIRCUIT_POLICY.failureWindowMs;
      const failures = (recent ? c.consecutiveFailures : 0) + 1;
      if (failures >= CIRCUIT_POLICY.failureThreshold) {
        await this.move(tx, c, 'open', 'failures', errorCode, jobId, done, {
          consecutiveFailures: failures,
          openedAt: now,
          retryAt: new Date(now.getTime() + CIRCUIT_POLICY.openForMs),
          openForMs: CIRCUIT_POLICY.openForMs,
          lastErrorCode: errorCode,
          lastFailureAt: now,
        });
      } else {
        await tx.providerCircuit.update({
          where: { providerId },
          data: { consecutiveFailures: failures, lastFailureAt: now, lastErrorCode: errorCode },
        });
      }
    });
    this.emit(done);
  }

  /** Operator action (operations page, CLI): open for the default time, or close. */
  async set(
    providerId: string,
    state: 'open' | 'closed',
    actorId: string | null,
  ): Promise<ProviderCircuit> {
    const done: CircuitTransition[] = [];
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, providerId);
      if (c.state === state) return c;
      const now = this.now();
      const data =
        state === 'closed'
          ? CLOSED
          : {
              openedAt: now,
              retryAt: new Date(now.getTime() + CIRCUIT_POLICY.openForMs),
              openForMs: CIRCUIT_POLICY.openForMs,
              trialJobId: null,
              trialStartedAt: null,
            };
      return this.move(tx, c, state, 'manual', null, null, done, data, actorId);
    });
    this.emit(done);
    return row;
  }

  /** Every provider's circuit (closed rows are created on first use). */
  list(): Promise<(ProviderCircuit & { provider: { key: string; name: string } })[]> {
    return this.prisma.providerCircuit.findMany({
      include: { provider: { select: { key: true, name: true } } },
      orderBy: { provider: { key: 'asc' } },
    });
  }

  private async lock(tx: TransactionClient, providerId: string): Promise<ProviderCircuit> {
    await tx.providerCircuit.upsert({ where: { providerId }, create: { providerId }, update: {} });
    await tx.$queryRaw`SELECT 1 FROM provider_circuits WHERE provider_id = ${providerId}::uuid FOR UPDATE`;
    return tx.providerCircuit.findUniqueOrThrow({ where: { providerId } });
  }

  private async move(
    tx: TransactionClient,
    c: ProviderCircuit,
    to: CircuitState,
    reason: string,
    errorCode: string | null,
    jobId: string | null,
    done: CircuitTransition[],
    data: Partial<Omit<ProviderCircuit, 'providerId' | 'state' | 'createdAt' | 'updatedAt'>>,
    actorId: string | null = null,
  ): Promise<ProviderCircuit> {
    const row = await tx.providerCircuit.update({
      where: { providerId: c.providerId },
      data: { ...data, state: to },
    });
    await tx.providerCircuitEvent.create({
      data: {
        providerId: c.providerId,
        fromState: c.state,
        toState: to,
        reason,
        errorCode,
        jobId,
        actorId,
      },
    });
    done.push({ providerId: c.providerId, from: c.state, to, reason, errorCode, jobId });
    return row;
  }

  private emit(done: readonly CircuitTransition[]): void {
    for (const t of done) this.options.onTransition?.(t);
  }
}

const CLOSED = {
  consecutiveFailures: 0,
  openedAt: null,
  retryAt: null,
  openForMs: CIRCUIT_POLICY.openForMs,
  trialJobId: null,
  trialStartedAt: null,
} as const;
