// How Prisma 7 + @prisma/adapter-pg surfaces the integrity layer's errors, and the extractor
// the API error mapper relies on (design package §8.3). Ported from evidence/sql/errtest.ts.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createPrismaClient, databaseErrorInfo, type PrismaClient } from '../src/index.js';
import { C, P, seed, U, V1, V2, X } from './support/concurrency-scenarios.js';
import { connect, truncateAll } from './support/db.js';

let migrator: pg.Client;
let app: pg.Client;
let prisma: PrismaClient;

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await seed(app, 'primary');
  prisma = createPrismaClient({ databaseUrl: inject('databaseUrls').appUrl, maxConnections: 2 });
});

afterAll(async () => {
  await prisma.$disconnect();
  await app.end();
  await migrator.end();
});

describe('Prisma error shapes', () => {
  it('generates UUIDv7 ids client-side', async () => {
    const created = await prisma.characterVersion.create({
      data: { projectId: P, characterId: C, version: 3, description: 'v3', createdById: U },
    });
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(created.status).toBe('draft');
  });

  it('approves through an interactive transaction (service algorithm, §7)', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM character_versions WHERE id = ${V1}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM characters WHERE id = ${C}::uuid FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM assets WHERE id = ${X}::uuid ORDER BY id FOR NO KEY UPDATE`;
      await tx.characterVersion.update({
        where: { id: V1, status: 'draft' },
        data: { status: 'approved', approvedAt: new Date(), approvedById: U },
      });
      await tx.character.update({ where: { id: C }, data: { masterVersionId: V1 } });
    });
    const character = await prisma.character.findUniqueOrThrow({ where: { id: C } });
    expect(character.masterVersionId).toBe(V1);
  });

  it('surfaces a row-trigger error on a model operation (AC001)', async () => {
    const error = await caught(() =>
      prisma.characterVersion.update({ where: { id: V1 }, data: { description: 'x' } }),
    );
    expect(databaseErrorInfo(error)?.sqlState).toBe('AC001');
  });

  it('surfaces a deferred-trigger error raised at COMMIT (AC004)', async () => {
    const error = await caught(() =>
      prisma.$transaction(async (tx) => {
        await tx.characterVersion.update({
          where: { id: V2 },
          data: { status: 'approved', approvedAt: new Date(), approvedById: U },
        });
      }),
    );
    expect(databaseErrorInfo(error)?.sqlState).toBe('AC004');
    const v2 = await prisma.characterVersion.findUniqueOrThrow({ where: { id: V2 } });
    expect(v2.status).toBe('draft');
  });

  it('surfaces raw-query trigger errors (AC006)', async () => {
    const error = await caught(() => prisma.$executeRaw`DELETE FROM assets WHERE id = ${X}::uuid`);
    expect(databaseErrorInfo(error)?.sqlState).toBe('AC006');
  });

  it('reports the constraint of a unique violation', async () => {
    const error = await caught(() =>
      prisma.character.create({
        data: { projectId: P, name: 'dup', slug: 'c', createdById: U },
      }),
    );
    expect(databaseErrorInfo(error)).toMatchObject({
      sqlState: '23505',
      constraint: 'characters_project_id_slug_key',
    });
  });

  it('surfaces composite foreign-key violations (cross-project reference)', async () => {
    const otherProjectAsset = '20000000-0000-7000-8000-0000000000ee';
    const error = await caught(() =>
      prisma.characterVersionAsset.create({
        data: { projectId: P, characterVersionId: V2, assetId: otherProjectAsset },
      }),
    );
    expect(databaseErrorInfo(error)?.sqlState).toBe('23503');
  });
});
