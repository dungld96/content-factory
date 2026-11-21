// Restore drill for object storage (M8 design §5, ADR-0020): export a bucket, import it into an
// empty one, verify every object and every database asset row; and the refusals that protect a
// restore (tampered files, unsafe keys). The database half (pg_dump/pg_restore inside the
// PostgreSQL container) is exercised by `scripts/backup-drill.sh`.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { storageSettings } from '@acf/config';
import type { PrismaClient } from '@acf/database';
import {
  assetObjectKey,
  objectPath,
  S3ObjectStore,
  sha256Hex,
  type ObjectManifest,
} from '@acf/storage';
import { ensureBucket, storageAdminSettingsFromEnv } from '@acf/storage/admin';
import { solidPng } from '@acf/storage/testing';

import { runStorageCli } from '../../src/cli/storage-cli.js';
import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import { seedUsers } from '../support/workspace.js';

let db: pg.Client;
let prisma: PrismaClient;
let api: AuthTestApp;
let ids: Record<string, string>;
let work: string;
const suffix = randomUUID().slice(0, 8);
const SOURCE = `acf-drill-src-${suffix}`;
const TARGET = `acf-drill-dst-${suffix}`;

const envFor = (bucket: string) => ({ ...process.env, S3_BUCKET: bucket });

async function cli(args: string, bucket: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runStorageCli(args.split(' ').filter(Boolean), prisma, envFor(bucket), {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function storeOf(bucket: string): S3ObjectStore {
  const settings = storageSettings({ ...api.env, S3_BUCKET: bucket });
  if (!settings) throw new Error('backup tests need object storage (S3_* variables)');
  return new S3ObjectStore(settings);
}

/** One stored image and its asset row, as an upload writes them. */
async function storedAsset(projectId: string, bucket: string, seed: number): Promise<string> {
  const assetId = randomUUID();
  const bytes = solidPng(9 + seed, 16, seed);
  const sum = sha256Hex(bytes);
  const key = assetObjectKey({ projectId, assetId, sha256Hex: sum, mimeType: 'image/png' });
  await storeOf(bucket).putIfAbsent(key, bytes, { contentType: 'image/png', sha256Hex: sum });
  await db.query(
    `INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes,
       checksum_sha256, created_by_id, updated_at)
     VALUES ($1, $2, 'reference', 'upload', $3, 'image/png', $4, $5, $6, now())`,
    [assetId, projectId, key, bytes.byteLength, sum, ids['owner']],
  );
  return key;
}

/** A project without content or assets (only the drill's own asset rows exist). */
async function bareProject(): Promise<{ projectId: string }> {
  const projectId = randomUUID();
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'Drill', 'drill-${projectId.slice(0, 8)}', 'vi', 'UTC', '${ids['owner'] ?? ''}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at)
      VALUES ('${projectId}', '${ids['owner'] ?? ''}', 'owner', now());
    COMMIT;`);
  return { projectId };
}

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  ids = await seedUsers(admin.users);
  api = await startAuthApp({});
  const storageAdmin = storageAdminSettingsFromEnv(process.env);
  await ensureBucket(storageAdmin, SOURCE);
  await ensureBucket(storageAdmin, TARGET);
  work = await mkdtemp(path.join(os.tmpdir(), 'acf-backup-'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('restore drill (objects)', () => {
  it('exports every object, restores it into an empty bucket, and verifies objects and asset rows', async () => {
    const f = await bareProject();
    const keys = [
      await storedAsset(f.projectId, SOURCE, 1),
      await storedAsset(f.projectId, SOURCE, 2),
      await storedAsset(f.projectId, SOURCE, 3),
    ];
    const dir = path.join(work, 'backup-1');

    const exported = await cli(`export ${dir}`, SOURCE);
    expect(exported).toMatchObject({ code: 0 });
    expect(exported.out).toMatch(/exported 3 object\(s\)/);
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'objects.json'), 'utf8'),
    ) as ObjectManifest;
    expect(manifest).toMatchObject({ format: 'acf-objects/1', bucket: SOURCE });
    expect(manifest.objects.map((o) => o.key).sort()).toEqual([...keys].sort());

    // The target is empty: every database asset is missing there before the import.
    const before = await cli('verify', TARGET);
    expect(before.code).toBe(1);
    expect(before.err).toMatch(/database assets vs bucket: \d+ problem/);

    const imported = await cli(`import ${dir}`, TARGET);
    expect(imported).toMatchObject({ code: 0 });
    expect(imported.out).toContain('3 written, 0 already present');
    const verified = await cli(`verify ${dir} --deep`, TARGET);
    expect(verified.err).toBe('');
    expect(verified).toMatchObject({ code: 0 });
    expect(verified.out).toContain(
      'bucket holds all 3 object(s) of the manifest (checksums verified)',
    );

    // Importing again is harmless (write-once).
    expect((await cli(`import ${dir}`, TARGET)).out).toContain('0 written, 3 already present');
  });

  it('refuses a backup whose files were changed', async () => {
    const f = await bareProject();
    await storedAsset(f.projectId, SOURCE, 4);
    const dir = path.join(work, 'backup-2');
    expect((await cli(`export ${dir}`, SOURCE)).code).toBe(0);
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'objects.json'), 'utf8'),
    ) as ObjectManifest;
    const victim = manifest.objects[0];
    if (!victim) throw new Error('empty export');
    const file = objectPath(dir, victim.key);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await writeFile(file, bytes);

    const res = await cli(`import ${dir}`, `acf-drill-never-${suffix}`);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`checksum: ${victim.key}`);
  });

  it('never writes outside the backup directory', () => {
    expect(() => objectPath(work, '../escape')).toThrow(/unsafe object key/);
    expect(() => objectPath(work, '/etc/passwd')).toThrow(/unsafe object key/);
    expect(() => objectPath(work, 'projects/a/../../x')).toThrow(/unsafe object key/);
    expect(objectPath(work, 'projects/a/assets/b/c.png')).toBe(
      path.join(work, 'objects', 'projects/a/assets/b/c.png'),
    );
  });
});
