// Object-storage backup CLI (M8 design §5, ADR-0020). From the repository root:
//   pnpm --filter @acf/api storage export <dir>         every object + objects.json (SHA-256)
//   pnpm --filter @acf/api storage import <dir>         write them back (write-once), verified
//   pnpm --filter @acf/api storage verify [<dir>] [--deep]
// `verify` checks: the backup files against their manifest (with <dir>), the bucket against the
// manifest, and every asset row of the database against the bucket (size; SHA-256 with --deep).
// On the VM these run inside the api container (`acf.sh backup` / `acf.sh restore`).
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { storageEnvShape, storageSettings } from '@acf/config';
import { createPrismaClient, type PrismaClient } from '@acf/database';
import {
  exportObjects,
  importObjects,
  readObjectManifest,
  S3ObjectStore,
  verifyBackupFiles,
  verifyObjects,
  type VerifyProblem,
} from '@acf/storage';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Largest object the import holds in memory (renders are the largest objects, well below this). */
const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

const describe = (problems: readonly VerifyProblem[], limit = 20) =>
  problems
    .slice(0, limit)
    .map((p) => `  ${p.problem}: ${p.key}`)
    .join('\n');

export async function runStorageCli(
  argv: readonly string[],
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { deep: { type: 'boolean', default: false } },
  });
  const [command, dir] = positionals;
  const env = z.object(storageEnvShape).safeParse(rawEnv);
  const settings = env.success ? storageSettings(env.data) : null;
  if (!settings) {
    io.err(
      'Object storage is not configured (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).',
    );
    return 2;
  }
  const store = new S3ObjectStore(settings);

  if (command === 'export' && dir) {
    const manifest = await exportObjects(store, dir);
    const bytes = manifest.objects.reduce((n, o) => n + o.sizeBytes, 0);
    io.out(
      `✔ exported ${String(manifest.objects.length)} object(s), ${String(bytes)} bytes, from ${manifest.bucket} to ${dir}`,
    );
    return 0;
  }

  if (command === 'import' && dir) {
    const broken = await verifyBackupFiles(dir);
    if (broken.length > 0) {
      io.err(
        `✖ the backup files do not match their manifest (${String(broken.length)}):\n${describe(broken)}`,
      );
      return 1;
    }
    const report = await importObjects(store, dir, MAX_OBJECT_BYTES);
    io.out(
      `✔ imported into ${settings.bucket}: ${String(report.created)} written, ${String(report.existing)} already present`,
    );
    const problems = await verifyObjects(store, (await readObjectManifest(dir)).objects, false);
    if (problems.length > 0) {
      io.err(
        `✖ after import the bucket differs from the manifest (${String(problems.length)}):\n${describe(problems)}`,
      );
      return 1;
    }
    return 0;
  }

  if (command === 'verify') {
    const deep = values.deep;
    let failed = false;
    if (dir) {
      const files = await verifyBackupFiles(dir);
      if (files.length > 0) {
        failed = true;
        io.err(
          `✖ backup files vs manifest: ${String(files.length)} problem(s)\n${describe(files)}`,
        );
      } else io.out('✔ backup files match their manifest');
      const manifest = await readObjectManifest(dir);
      const bucket = await verifyObjects(store, manifest.objects, deep);
      if (bucket.length > 0) {
        failed = true;
        io.err(`✖ bucket vs manifest: ${String(bucket.length)} problem(s)\n${describe(bucket)}`);
      } else
        io.out(
          `✔ bucket holds all ${String(manifest.objects.length)} object(s) of the manifest${deep ? ' (checksums verified)' : ''}`,
        );
    }
    const assets = await prisma.asset.findMany({
      select: { storageKey: true, sizeBytes: true, checksumSha256: true },
    });
    const db = await verifyObjects(
      store,
      assets.map((a) => ({
        key: a.storageKey,
        sizeBytes: Number(a.sizeBytes),
        sha256: a.checksumSha256,
      })),
      deep,
    );
    if (db.length > 0) {
      failed = true;
      io.err(`✖ database assets vs bucket: ${String(db.length)} problem(s)\n${describe(db)}`);
    } else
      io.out(
        `✔ every asset of the database (${String(assets.length)}) is in the bucket${deep ? ' with its checksum' : ''}`,
      );
    return failed ? 1 : 0;
  }

  io.err('usage: storage export <dir> | storage import <dir> | storage verify [<dir>] [--deep]');
  return 2;
}

async function main(): Promise<number> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (see .env.example).');
    return 2;
  }
  const prisma = createPrismaClient({ databaseUrl, maxConnections: 1 });
  try {
    return await runStorageCli(process.argv.slice(2), prisma, process.env, {
      out: (line) => {
        console.info(line);
      },
      err: (line) => {
        console.error(line);
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when executed directly (tests import runStorageCli).
if (process.argv[1]?.endsWith('storage-cli.js')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
