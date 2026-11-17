import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from './prisma.service.js';
import { TransactionRunner } from './transaction-runner.js';

const dbError = (code: string) => ({ name: 'DriverAdapterError', cause: { originalCode: code } });

function runnerWith(transaction: ReturnType<typeof vi.fn>) {
  const prisma = { client: { $transaction: transaction } } as unknown as PrismaService;
  return new TransactionRunner(prisma);
}

describe('TransactionRunner', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('runs at READ COMMITTED and returns the result', async () => {
    const transaction = vi.fn().mockResolvedValue('ok');
    await expect(runnerWith(transaction).run('t', () => Promise.resolve('x'))).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
    });
  });

  it.each(['40001', '40P01'])('retries once on %s', async (code) => {
    const transaction = vi.fn().mockRejectedValueOnce(dbError(code)).mockResolvedValue('ok');
    await expect(runnerWith(transaction).run('t', () => Promise.resolve(1))).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry', async () => {
    const transaction = vi.fn().mockRejectedValue(dbError('40001'));
    await expect(runnerWith(transaction).run('t', () => Promise.resolve(1))).rejects.toEqual(
      dbError('40001'),
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([dbError('AC007'), new Error('app error')])('does not retry %o', async (error) => {
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(runnerWith(transaction).run('t', () => Promise.resolve(1))).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
