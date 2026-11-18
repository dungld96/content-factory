import pg from 'pg';
import { inject } from 'vitest';

export type Role = 'migrator' | 'app';

/** Opens a connection to the test database as the given role. Callers must `end()` it. */
export async function connect(role: Role): Promise<pg.Client> {
  const urls = inject('databaseUrls');
  const client = new pg.Client({
    connectionString: role === 'migrator' ? urls.migratorUrl : urls.appUrl,
  });
  await client.connect();
  return client;
}

/** Every table of the M1–M3 and R0 schema. TRUNCATE bypasses row triggers by design (ADR-0011). */
export const ALL_TABLES = [
  'users',
  'sessions',
  'projects',
  'project_members',
  'channels',
  'characters',
  'character_versions',
  'character_version_assets',
  'environments',
  'environment_versions',
  'environment_version_assets',
  'assets',
  'content_masters',
  'content_items',
  'ai_providers',
  'ai_models',
  'ai_model_capabilities',
  'ai_model_prices',
  'ai_invocations',
  'ai_usage_records',
  'production_runs',
  'generation_jobs',
  'job_events',
  'script_versions',
  'storyboard_versions',
  'storyboard_scenes',
  'storyboard_scene_assets',
  'ai_task_routes',
] as const;

/** Empties every table. Must run as the migrator (the app role has no TRUNCATE). */
export async function truncateAll(migrator: pg.Client): Promise<void> {
  await migrator.query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** PostgreSQL SQLSTATE of a `pg` error, or undefined. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Runs `sql` in its own transaction, forces deferred constraint triggers to fire, and returns
 * the SQLSTATE it failed with (`null` if it succeeded). Always rolls back, so a rejected
 * statement leaves no trace.
 */
export async function sqlStateOfAttempt(client: pg.Client, sql: string): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    return null;
  } catch (error) {
    return sqlStateOf(error) ?? 'NO_SQLSTATE';
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Runs `sql` in a transaction and commits it (deferred triggers fire at COMMIT). */
export async function commit(client: pg.Client, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
