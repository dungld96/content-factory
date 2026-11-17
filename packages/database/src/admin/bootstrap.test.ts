import { describe, expect, it } from 'vitest';

import { bootstrapDatabase, credentialsFromUrl, withDatabase } from './bootstrap.js';

describe('credentialsFromUrl', () => {
  it('parses role, password and database', () => {
    expect(
      credentialsFromUrl(
        'X',
        'postgresql://acf_app:s%40cret-pass@localhost:5432/acf?schema=public',
      ),
    ).toEqual({ role: 'acf_app', password: 's@cret-pass', database: 'acf' });
  });

  it.each([
    ['not a URL', 'nope'],
    ['wrong scheme', 'mysql://a:password1@h/db'],
    ['unsafe role name', 'postgresql://"x;drop":password1@h/db'],
    ['unsafe database name', 'postgresql://acf_app:password1@h/acf;drop'],
    ['short password', 'postgresql://acf_app:short@h/acf'],
  ])('rejects %s without echoing the value', (_name, url) => {
    let message = '';
    try {
      credentialsFromUrl('DATABASE_URL', url);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^DATABASE_URL/);
    expect(message).not.toContain('password1');
  });
});

describe('withDatabase', () => {
  it('swaps the database and keeps the query string', () => {
    expect(withDatabase('postgresql://u:p@h:5432/acf?schema=public', 'acf_test')).toBe(
      'postgresql://u:p@h:5432/acf_test?schema=public',
    );
  });
});

describe('bootstrapDatabase validation', () => {
  const admin = 'postgresql://acf:password1@localhost/acf';
  it('requires three distinct roles', async () => {
    await expect(
      bootstrapDatabase({
        adminUrl: admin,
        migratorUrl: 'postgresql://acf_app:password1@localhost/acf',
        appUrl: 'postgresql://acf_app:password1@localhost/acf',
      }),
    ).rejects.toThrow(/three different roles/);
  });
  it('requires the migrator and app to target the same database', async () => {
    await expect(
      bootstrapDatabase({
        adminUrl: admin,
        migratorUrl: 'postgresql://acf_migrator:password1@localhost/acf',
        appUrl: 'postgresql://acf_app:password1@localhost/other',
      }),
    ).rejects.toThrow(/same database/);
  });
});
