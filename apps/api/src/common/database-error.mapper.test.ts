import { describe, expect, it } from 'vitest';

import { mapDatabaseError } from './database-error.mapper.js';

/** Shape of a Prisma 7 adapter-pg error (verified in packages/database/test). */
const prismaError = (originalCode: string, index?: string) => ({
  name: 'PrismaClientKnownRequestError',
  code: 'P2010',
  meta: {
    driverAdapterError: {
      cause: { originalCode, ...(index ? { constraint: { index } } : {}) },
    },
  },
});

describe('mapDatabaseError', () => {
  it.each([
    ['AC001', 409, 'VERSION_IMMUTABLE'],
    ['AC002', 409, 'VERSION_LINKS_FROZEN'],
    ['AC003', 409, 'MASTER_CONFLICT'],
    ['AC004', 409, 'MASTER_CONFLICT'],
    ['AC005', 409, 'ASSET_IDENTITY_IMMUTABLE'],
    ['AC006', 409, 'ARCHIVE_ONLY'],
    ['AC007', 409, 'LAST_OWNER'],
    ['AC008', 409, 'ASSET_IN_USE'],
    ['AC009', 409, 'VERSION_IMMUTABLE'],
    ['AC010', 409, 'ASSET_ARCHIVED'],
    ['AC011', 409, 'LEDGER_IMMUTABLE'],
    ['AC012', 409, 'ARTIFACT_IMMUTABLE'],
    ['AC013', 409, 'STALE_STORYBOARD'],
    ['AC015', 409, 'KEYFRAME_INVALID'],
    ['AC016', 409, 'SCENE_SELECTION_INVALID'],
    ['AC017', 409, 'RENDER_NOT_APPROVED'],
    ['23503', 422, 'REFERENCE_NOT_FOUND'],
    ['23514', 422, 'CONSTRAINT_VIOLATION'],
  ])('maps %s to %i %s', (sqlState, status, code) => {
    const mapped = mapDatabaseError(prismaError(sqlState));
    expect(mapped?.error.getStatus()).toBe(status);
    expect(mapped?.error.getResponse()).toMatchObject({ code });
  });

  it.each(['40001', '40P01'])('maps %s to a retryable CONCURRENT_MODIFICATION', (sqlState) => {
    const mapped = mapDatabaseError({
      name: 'DriverAdapterError',
      cause: { originalCode: sqlState },
    });
    expect(mapped?.sqlState).toBe(sqlState);
    expect(mapped?.error.getResponse()).toMatchObject({
      code: 'CONCURRENT_MODIFICATION',
      retryable: true,
    });
  });

  it.each([
    ['users_email_key', 'EMAIL_TAKEN'],
    ['projects_slug_key', 'SLUG_TAKEN'],
    ['characters_project_id_slug_key', 'SLUG_TAKEN'],
    ['assets_storage_key_key', 'STORAGE_KEY_TAKEN'],
    ['character_versions_character_id_version_key', 'CONFLICT'],
    [undefined, 'CONFLICT'],
  ])('maps unique violation on %s to %s', (index, code) => {
    expect(mapDatabaseError(prismaError('23505', index))?.error.getResponse()).toMatchObject({
      code,
    });
  });

  it('never exposes the driver message', () => {
    const error = {
      name: 'DriverAdapterError',
      cause: { originalCode: 'AC001', originalMessage: 'secret internals' },
    };
    expect(JSON.stringify(mapDatabaseError(error)?.error.getResponse())).not.toContain('secret');
  });

  it('leaves unknown SQLSTATEs and non-database errors unmapped', () => {
    expect(mapDatabaseError(prismaError('22012'))).toBeUndefined();
    expect(mapDatabaseError(new Error('boom'))).toBeUndefined();
  });
});
