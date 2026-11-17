// Account provisioning used by the CLI (decision D6; ADR-0009 requirement 5).
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@acf/database';

import type { UserAdminService } from '../../src/users/user-admin.service.js';
import { inspector, PASSWORD, resetDatabase, userAdmin } from '../support/auth-app.js';

let db: pg.Client;
let users: UserAdminService;
let prisma: PrismaClient;

const SESSION_ROW = (
  n: number,
) => `INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at)
  SELECT decode(repeat('${String(n).padStart(2, '0')}', 32), 'hex'), id, '{}', now() + interval '1 day', now() + interval '7 days'
  FROM users WHERE email = 'a@example.test'`;

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  ({ users, prisma } = userAdmin());
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

describe('UserAdminService', () => {
  it('creates a user with a normalized email and an Argon2id hash', async () => {
    const user = await users.create({
      email: ' A@Example.TEST ',
      displayName: 'A',
      password: PASSWORD,
    });
    expect(user.email).toBe('a@example.test');
    const { rows } = await db.query<{ password_hash: string; status: string }>(
      'SELECT password_hash, status FROM users WHERE id = $1',
      [user.id],
    );
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
  });

  it.each([
    [{ email: 'a@example.test', displayName: 'Dup', password: PASSWORD }, 'EMAIL_TAKEN'],
    [{ email: 'b@example.test', displayName: 'B', password: 'short' }, 'INVALID_INPUT'],
    [{ email: 'not-an-email', displayName: 'B', password: PASSWORD }, 'INVALID_INPUT'],
    [{ email: 'c@example.test', displayName: ' ', password: PASSWORD }, 'INVALID_INPUT'],
  ])('rejects %o with %s', async (input, code) => {
    await expect(users.create(input)).rejects.toMatchObject({ code });
  });

  it('changes the password and revokes every session in the same transaction', async () => {
    await db.query(SESSION_ROW(1));
    await db.query(SESSION_ROW(2));
    expect(await users.setPassword('A@example.test', 'another long password')).toBe(2);
    const { rows } = await db.query<{ n: number; changed: boolean }>(
      `SELECT (SELECT count(*)::int FROM sessions) AS n,
              password_changed_at > created_at AS changed FROM users WHERE email = 'a@example.test'`,
    );
    expect(rows[0]).toEqual({ n: 0, changed: true });
  });

  it('disables the account and revokes its sessions', async () => {
    await db.query(SESSION_ROW(3));
    expect(await users.disable('a@example.test')).toBe(1);
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM users WHERE email = 'a@example.test'`,
    );
    expect(rows[0]?.status).toBe('disabled');
  });

  it('reports unknown users', async () => {
    await expect(users.disable('nobody@example.test')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
    await expect(users.setPassword('nobody@example.test', PASSWORD)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
});
