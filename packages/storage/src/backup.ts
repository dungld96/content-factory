import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ObjectStore } from './object-store.js';

/**
 * Object-storage backup (M8 design §5, ADR-0020): every object of the bucket as a file under
 * `<dir>/objects/<key>` plus `<dir>/objects.json` (key, size, SHA-256, content type). Objects are
 * write-once and content-addressed, so an export taken while the application runs is consistent
 * for every object that existed when it started; later objects are simply not in it.
 */

export const OBJECT_MANIFEST = 'objects.json';
export const OBJECT_DIR = 'objects';

export interface ObjectEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentType: string | null;
}

export interface ObjectManifest {
  readonly format: 'acf-objects/1';
  readonly bucket: string;
  readonly exportedAt: string;
  readonly objects: readonly ObjectEntry[];
}

/** Keys the application writes (`projects/<uuid>/assets/<uuid>/<sha>.<ext>` and alike). */
const SAFE_KEY = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,1024}$/;

export class BackupError extends Error {
  override readonly name = 'BackupError';
}

/** The file of `key` inside `dir`; refuses keys that could escape it. */
export function objectPath(dir: string, key: string): string {
  if (!SAFE_KEY.test(key)) throw new BackupError(`unsafe object key: ${JSON.stringify(key)}`);
  const root = path.resolve(dir, OBJECT_DIR);
  const file = path.resolve(root, key);
  if (!file.startsWith(root + path.sep)) throw new BackupError(`unsafe object key: ${key}`);
  return file;
}

/** Discards what it receives (the hash is all that is needed). */
const sink = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

/** Hashes what passes through. */
function hasher(): { stream: Transform; digest: () => { sha256: string; size: number } } {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, digest: () => ({ sha256: hash.digest('hex'), size }) };
}

export interface ListableStore extends ObjectStore {
  listKeys(prefix?: string): AsyncIterable<string>;
  readonly bucketName: string;
}

/** Streams every object to `dir` and writes the manifest. Returns it. */
export async function exportObjects(
  store: ListableStore,
  dir: string,
  onProgress?: (done: number) => void,
): Promise<ObjectManifest> {
  await mkdir(path.join(dir, OBJECT_DIR), { recursive: true });
  const objects: ObjectEntry[] = [];
  for await (const key of store.listKeys()) {
    const file = objectPath(dir, key);
    const body = await store.get(key);
    if (!body) continue; // listed then gone: objects are never deleted, so this does not happen
    await mkdir(path.dirname(file), { recursive: true });
    const h = hasher();
    await pipeline(body.stream, h.stream, createWriteStream(file, { flags: 'wx' }));
    const { sha256, size } = h.digest();
    objects.push({ key, sizeBytes: size, sha256, contentType: body.contentType });
    onProgress?.(objects.length);
  }
  const manifest: ObjectManifest = {
    format: 'acf-objects/1',
    bucket: store.bucketName,
    exportedAt: new Date().toISOString(),
    objects,
  };
  await writeFile(path.join(dir, OBJECT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}

export async function readObjectManifest(dir: string): Promise<ObjectManifest> {
  const raw = JSON.parse(
    await readFile(path.join(dir, OBJECT_MANIFEST), 'utf8'),
  ) as Partial<ObjectManifest>;
  if (raw.format !== 'acf-objects/1' || !Array.isArray(raw.objects)) {
    throw new BackupError(`${OBJECT_MANIFEST} is not an ACF object manifest`);
  }
  return raw as ObjectManifest;
}

async function fileSha256(file: string): Promise<{ sha256: string; size: number }> {
  const h = hasher();
  await pipeline(createReadStream(file), h.stream, sink());
  return h.digest();
}

export interface ImportReport {
  readonly created: number;
  readonly existing: number;
}

/**
 * Writes every object of the manifest back (write-once: an existing key is left untouched and
 * must already hold the same bytes, which {@link verifyObjects} checks). Each file is verified
 * against the manifest before upload, and the server verifies the checksum again.
 */
export async function importObjects(
  store: ObjectStore,
  dir: string,
  maxObjectBytes: number,
  onProgress?: (done: number) => void,
): Promise<ImportReport> {
  const manifest = await readObjectManifest(dir);
  let created = 0;
  let existing = 0;
  for (const entry of manifest.objects) {
    const file = objectPath(dir, entry.key);
    const info = await stat(file);
    if (info.size !== entry.sizeBytes)
      throw new BackupError(`${entry.key}: size differs from the manifest`);
    if (info.size > maxObjectBytes)
      throw new BackupError(`${entry.key}: larger than ${String(maxObjectBytes)} bytes`);
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256)
      throw new BackupError(`${entry.key}: checksum differs from the manifest`);
    const result = await store.putIfAbsent(entry.key, bytes, {
      contentType: entry.contentType ?? 'application/octet-stream',
      sha256Hex: sha256,
    });
    if (result === 'created') created += 1;
    else existing += 1;
    onProgress?.(created + existing);
  }
  return { created, existing };
}

export interface VerifyProblem {
  readonly key: string;
  readonly problem: 'missing' | 'size' | 'checksum';
}

/**
 * Checks that the store holds each expected object (by size; with `deep`, also by SHA-256 of
 * the stored bytes).
 */
export async function verifyObjects(
  store: ObjectStore,
  expected: readonly Pick<ObjectEntry, 'key' | 'sizeBytes' | 'sha256'>[],
  deep: boolean,
): Promise<VerifyProblem[]> {
  const problems: VerifyProblem[] = [];
  for (const e of expected) {
    const head = await store.head(e.key);
    if (!head) {
      problems.push({ key: e.key, problem: 'missing' });
      continue;
    }
    if (head.sizeBytes !== e.sizeBytes) {
      problems.push({ key: e.key, problem: 'size' });
      continue;
    }
    if (deep) {
      const body = await store.get(e.key);
      if (!body) {
        problems.push({ key: e.key, problem: 'missing' });
        continue;
      }
      const h = hasher();
      await pipeline(body.stream, h.stream, sink());
      if (h.digest().sha256 !== e.sha256) problems.push({ key: e.key, problem: 'checksum' });
    }
  }
  return problems;
}

/** Verifies the files of a backup directory against its manifest (before a restore). */
export async function verifyBackupFiles(dir: string): Promise<VerifyProblem[]> {
  const manifest = await readObjectManifest(dir);
  const problems: VerifyProblem[] = [];
  for (const e of manifest.objects) {
    try {
      const { sha256, size } = await fileSha256(objectPath(dir, e.key));
      if (size !== e.sizeBytes) problems.push({ key: e.key, problem: 'size' });
      else if (sha256 !== e.sha256) problems.push({ key: e.key, problem: 'checksum' });
    } catch {
      problems.push({ key: e.key, problem: 'missing' });
    }
  }
  return problems;
}
