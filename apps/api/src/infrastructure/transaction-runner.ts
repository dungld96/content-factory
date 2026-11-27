import { Injectable, Logger } from '@nestjs/common';

import { databaseErrorInfo, Prisma, PostgresSqlState, type TransactionClient } from '@acf/database';

import { PrismaService } from './prisma.service.js';

/**
 * Attempts per transaction: the first try plus one internal retry, for `40001` only
 * (design package §6.3.1).
 */
export const TRANSACTION_ATTEMPTS = 2;

/**
 * Runs interactive transactions at READ COMMITTED (ADR-0011 §6).
 *
 * Retry policy:
 * - `40001` (serialization failure): retried once. If the retry also loses, the error propagates.
 * - `40P01` (deadlock): never retried. Protocol-following paths cannot deadlock (ADR-0011 §6), so
 *   a deadlock is a defect: it is logged at error level and the original error propagates, so a
 *   retry cannot hide it.
 * - Anything else (`AC0xx`, other SQLSTATEs, application errors): never retried.
 *
 * Propagated errors are mapped by the exception filter (`40001`/`40P01` →
 * `409 CONCURRENT_MODIFICATION`, `retryable: true`). `fn` must be safe to re-run: it may only
 * have side effects inside the transaction.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);

  constructor(private readonly prisma: PrismaService) {}

  async run<T>(name: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        });
      } catch (error) {
        const sqlState = databaseErrorInfo(error)?.sqlState;
        if (sqlState === PostgresSqlState.DEADLOCK_DETECTED) {
          // Protocol-following paths cannot deadlock (ADR-0011 §6): this is a defect. Not retried.
          this.logger.error({ msg: 'deadlock_detected', transaction: name, sqlState, attempt });
          throw error;
        }
        if (
          sqlState !== PostgresSqlState.SERIALIZATION_FAILURE ||
          attempt >= TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
        this.logger.warn({ msg: 'transaction_retry', transaction: name, sqlState, attempt });
      }
    }
  }
}
