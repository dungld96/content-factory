import { Injectable, Logger } from '@nestjs/common';

import { databaseErrorInfo, Prisma, PostgresSqlState, type TransactionClient } from '@acf/database';

import { PrismaService } from './prisma.service.js';

const RETRYABLE = new Set<string>([
  PostgresSqlState.SERIALIZATION_FAILURE,
  PostgresSqlState.DEADLOCK_DETECTED,
]);

/** Attempts per transaction: the first try plus one internal retry (design package §6.3.1). */
export const TRANSACTION_ATTEMPTS = 2;

/**
 * Runs interactive transactions at READ COMMITTED (ADR-0011 §6) and retries once on
 * `40001`/`40P01`. If the retry also loses, the error propagates and the exception filter maps
 * it to `409 CONCURRENT_MODIFICATION` (`retryable: true`). `fn` must be safe to re-run: it may
 * only have side effects inside the transaction.
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
          // Protocol-following paths cannot deadlock (ADR-0011 §6): this is a defect.
          this.logger.error({ msg: 'deadlock_detected', transaction: name, attempt });
        }
        if (sqlState === undefined || !RETRYABLE.has(sqlState) || attempt >= TRANSACTION_ATTEMPTS) {
          throw error;
        }
        this.logger.warn({ msg: 'transaction_retry', transaction: name, sqlState, attempt });
      }
    }
  }
}
