import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from './prisma.service.js';
import { TRANSACTION_ATTEMPTS, TransactionRunner } from './transaction-runner.js';

/** Shape of a deferred-trigger error raised at COMMIT (see `databaseErrorInfo`). */
const dbError = (code: string) =>
  Object.assign(new Error(`db ${code}`), {
    name: 'DriverAdapterError',
    cause: { originalCode: code },
  });

const READ_COMMITTED = { isolationLevel: 'ReadCommitted' };

/**
 * A fake `$transaction` that invokes the callback (as Prisma does) and then applies the next
 * scripted outcome: an error to throw, or `undefined` to return the callback's result.
 */
function scriptedTransaction(outcomes: readonly (Error | undefined)[]) {
  let call = 0;
  return vi.fn<(fn: (tx: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>>(
    async (fn) => {
      const result = await fn({});
      const outcome = outcomes[call++];
      if (outcome !== undefined) throw outcome;
      return result;
    },
  );
}

function runnerWith(transaction: ReturnType<typeof vi.fn>) {
  const prisma = { client: { $transaction: transaction } } as unknown as PrismaService;
  return new TransactionRunner(prisma);
}

describe('TransactionRunner', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows exactly one internal retry', () => {
    expect(TRANSACTION_ATTEMPTS).toBe(2);
  });

  it('runs a successful transaction once at READ COMMITTED and returns its result', async () => {
    const transaction = scriptedTransaction([]);
    const callback = vi.fn().mockResolvedValue('ok');
    await expect(runnerWith(transaction).run('t', callback)).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), READ_COMMITTED);
  });

  it('retries 40001 exactly once and succeeds, at READ COMMITTED on every attempt', async () => {
    const transaction = scriptedTransaction([dbError('40001')]);
    const callback = vi.fn().mockResolvedValue('ok');
    await expect(runnerWith(transaction).run('t', callback)).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    for (const call of transaction.mock.calls) expect(call[1]).toEqual(READ_COMMITTED);
  });

  it('propagates the second error when 40001 occurs twice', async () => {
    const first = dbError('40001');
    const second = dbError('40001');
    const transaction = scriptedTransaction([first, second]);
    const callback = vi.fn().mockResolvedValue('ok');
    const outcome = runnerWith(transaction).run('t', callback);
    await expect(outcome).rejects.toBe(second);
    expect(transaction).toHaveBeenCalledTimes(TRANSACTION_ATTEMPTS);
    expect(callback).toHaveBeenCalledTimes(TRANSACTION_ATTEMPTS);
    for (const call of transaction.mock.calls) expect(call[1]).toEqual(READ_COMMITTED);
  });

  it('does not retry 40P01: runs once, logs a defect, and propagates the original error', async () => {
    const deadlock = dbError('40P01');
    const transaction = scriptedTransaction([deadlock, undefined]);
    const callback = vi.fn().mockResolvedValue('ok');
    const logError = vi.spyOn(Logger.prototype, 'error');
    const logWarn = vi.spyOn(Logger.prototype, 'warn');

    await expect(runnerWith(transaction).run('approve_version', callback)).rejects.toBe(deadlock);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), READ_COMMITTED);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith({
      msg: 'deadlock_detected',
      transaction: 'approve_version',
      sqlState: '40P01',
      attempt: 1,
    });
    // No retry was scheduled (the retry path logs `transaction_retry`).
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each([
    'AC001',
    'AC002',
    'AC003',
    'AC004',
    'AC005',
    'AC006',
    'AC007',
    'AC008',
    'AC009',
    'AC010',
  ])('does not retry integrity SQLSTATE %s', async (code) => {
    const error = dbError(code);
    const transaction = scriptedTransaction([error, undefined]);
    await expect(runnerWith(transaction).run('t', () => Promise.resolve(1))).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['23505', '23503', '23514', '57014'])(
    'does not retry other SQLSTATE %s',
    async (code) => {
      const error = dbError(code);
      const transaction = scriptedTransaction([error, undefined]);
      await expect(runnerWith(transaction).run('t', () => Promise.resolve(1))).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a generic application error thrown by the callback', async () => {
    const error = new Error('app error');
    const transaction = scriptedTransaction([]);
    const callback = vi.fn().mockRejectedValue(error);
    await expect(runnerWith(transaction).run('t', callback)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
