import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mergeEditedMetadata, reservedMetadataKeys, SYSTEM_METADATA_KEYS } from './assets.js';

describe('system asset metadata (P2a A2)', () => {
  it('lists each key once', () => {
    expect(new Set(SYSTEM_METADATA_KEYS).size).toBe(SYSTEM_METADATA_KEYS.length);
  });

  it('names the reserved keys a caller tries to set', () => {
    expect(reservedMetadataKeys({ note: 'x', purpose: 'music', clipHash: 'h' })).toEqual([
      'purpose',
      'clipHash',
    ]);
    expect(reservedMetadataKeys({ note: 'x' })).toEqual([]);
  });

  it('keeps stored reserved keys and replaces the editable ones', () => {
    const stored = { purpose: 'voiceover', audio: { codec: 'mp3' }, note: 'old', tag: 'a' };
    expect(mergeEditedMetadata(stored, { note: 'new' })).toEqual({
      note: 'new',
      purpose: 'voiceover',
      audio: { codec: 'mp3' },
    });
    expect(mergeEditedMetadata(stored, {})).toEqual({
      purpose: 'voiceover',
      audio: { codec: 'mp3' },
    });
  });

  it('tolerates stored metadata that is not an object', () => {
    expect(mergeEditedMetadata(null, { note: 'x' })).toEqual({ note: 'x' });
  });
});

describe('reserved metadata keys in the database trigger', () => {
  it('match SYSTEM_METADATA_KEYS (latest migration defining acf_system_metadata_keys)', () => {
    const dir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../database/prisma/migrations',
    );
    const sql = readdirSync(dir)
      .sort()
      .map((m) => {
        try {
          return readFileSync(path.join(dir, m, 'migration.sql'), 'utf8');
        } catch {
          return '';
        }
      })
      .filter((text) => text.includes('FUNCTION acf_system_metadata_keys'))
      .at(-1);
    const body = /acf_system_metadata_keys\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]/.exec(sql ?? '');
    const keys = [...(body?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...SYSTEM_METADATA_KEYS]);
  });
});
