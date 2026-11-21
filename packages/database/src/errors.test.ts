import { describe, expect, it } from 'vitest';

import { databaseErrorInfo } from './errors.js';

// Shapes captured from Prisma 7.10.1 + @prisma/adapter-pg against PostgreSQL
// (re-verified against a live database by test/prisma-errors.integration.test.ts).
describe('databaseErrorInfo', () => {
  it('reads a trigger SQLSTATE from a PrismaClientKnownRequestError', () => {
    const error = Object.assign(new Error('x'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2039',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode: 'AC001', originalMessage: 'immutable', kind: 'postgres' },
        },
      },
    });
    expect(databaseErrorInfo(error)).toEqual({ sqlState: 'AC001', message: 'immutable' });
  });

  it('reads the constraint of a unique violation', () => {
    const error = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index: 'users_email_key' },
          },
        },
      },
    };
    expect(databaseErrorInfo(error)).toEqual({ sqlState: '23505', constraint: 'users_email_key' });
  });

  it('reads a deferred-trigger error raised at COMMIT (bare DriverAdapterError)', () => {
    const error = { name: 'DriverAdapterError', cause: { originalCode: 'AC004' } };
    expect(databaseErrorInfo(error)?.sqlState).toBe('AC004');
  });

  it('reads pg driver errors, including PL/pgSQL P0 codes', () => {
    expect(databaseErrorInfo({ code: '40001', message: 'could not serialize' })?.sqlState).toBe(
      '40001',
    );
    expect(databaseErrorInfo({ code: 'P0001' })?.sqlState).toBe('P0001');
  });

  it('ignores Prisma-only codes and non-database errors', () => {
    expect(databaseErrorInfo({ name: 'PrismaClientKnownRequestError', code: 'P2025' })).toBe(
      undefined,
    );
    expect(databaseErrorInfo(new Error('boom'))).toBe(undefined);
    expect(databaseErrorInfo({ code: 'ECONNREFUSED' })).toBe(undefined);
    expect(databaseErrorInfo(null)).toBe(undefined);
    expect(databaseErrorInfo('AC001')).toBe(undefined);
  });
});
