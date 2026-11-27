import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';

const execFileAsync = promisify(execFile);

/**
 * Database role separation (ADR-0011 §8, decision U3).
 *
 * - The **admin** role (a superuser such as the compose `POSTGRES_USER`) is used only here, to
 *   create roles and databases. Local development and CI only; never used by the application.
 * - The **migrator** role (`acf_migrator`) owns the databases, the schema objects and the
 *   triggers. Migrations, seed and test setup run as it.
 * - The **app** role (`acf_app`) is what the API connects as: `SELECT/INSERT/UPDATE/DELETE` only.
 *   It cannot disable or drop triggers, truncate, or switch `session_replication_role`.
 *
 * Role names, passwords and database names are read from the connection URLs, so the URLs in
 * the environment are the single source of truth.
 */
export interface DatabaseRoleUrls {
  /** Superuser connection (any database on the server). */
  readonly adminUrl: string;
  /** Connection for the schema-owner role; its database is created/owned by it. */
  readonly migratorUrl: string;
  /** Connection for the runtime DML-only role; must target the same database as `migratorUrl`. */
  readonly appUrl: string;
}

export interface BootstrapOptions {
  /** Additional databases to create and grant in the same way (e.g. a shadow database). */
  readonly extraDatabases?: readonly string[];
}

interface Credentials {
  readonly role: string;
  readonly password: string;
  readonly database: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export class DatabaseBootstrapError extends Error {
  override readonly name = 'DatabaseBootstrapError';
}

function assertIdentifier(kind: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new DatabaseBootstrapError(
      `${kind} must match ${IDENTIFIER.source} (lowercase letters, digits, underscore)`,
    );
  }
}

/** Parses role, password and database from a PostgreSQL URL. Never includes values in errors. */
export function credentialsFromUrl(label: string, url: string): Credentials {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseBootstrapError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseBootstrapError(`${label} must use the postgres:// or postgresql:// scheme`);
  }
  const role = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  assertIdentifier(`${label} user`, role);
  assertIdentifier(`${label} database`, database);
  if (password.length < 8) {
    throw new DatabaseBootstrapError(`${label} must include a password of at least 8 characters`);
  }
  return { role, password, database };
}

/** Returns `url` with its database name replaced (query string such as `?schema=` is kept). */
export function withDatabase(url: string, database: string): string {
  assertIdentifier('database', database);
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

async function ensureRole(admin: pg.Client, creds: Credentials): Promise<void> {
  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [creds.role]);
  const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
  // Identifiers are validated above; the password is quoted with the driver's literal escaping.
  await admin.query(
    `${verb} ROLE ${pg.escapeIdentifier(creds.role)} ${ROLE_ATTRIBUTES} PASSWORD ${pg.escapeLiteral(creds.password)}`,
  );
}

async function ensureDatabase(admin: pg.Client, database: string, owner: string): Promise<void> {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  const db = pg.escapeIdentifier(database);
  const ownerId = pg.escapeIdentifier(owner);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${db} OWNER ${ownerId}`);
  } else {
    await admin.query(`ALTER DATABASE ${db} OWNER TO ${ownerId}`);
  }
}

/**
 * Applies the grants for one database. Idempotent; safe to run before and after migrations.
 * Run it again after `prisma migrate deploy` so the app role loses access to
 * `_prisma_migrations` (default privileges grant it DML when the table is created).
 */
async function applyGrants(
  adminUrl: string,
  database: string,
  migrator: string,
  app: string,
): Promise<void> {
  const db = pg.escapeIdentifier(database);
  const m = pg.escapeIdentifier(migrator);
  const a = pg.escapeIdentifier(app);
  await withClient(withDatabase(adminUrl, database), async (client) => {
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${a}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${m}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${a}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${m} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${a}`,
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${a}`,
    );
    const migrations = await client.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'`,
    );
    if (migrations.rowCount !== 0) {
      await client.query(`REVOKE ALL ON TABLE public._prisma_migrations FROM ${a}`);
    }
  });
}

/**
 * Creates or updates the migrator and app roles, creates the target database(s) owned by the
 * migrator, and applies the app role's grants. Idempotent.
 */
export async function bootstrapDatabase(
  urls: DatabaseRoleUrls,
  options: BootstrapOptions = {},
): Promise<{ readonly databases: readonly string[] }> {
  const admin = credentialsFromUrl('DATABASE_ADMIN_URL', urls.adminUrl);
  const migrator = credentialsFromUrl('DATABASE_MIGRATION_URL', urls.migratorUrl);
  const app = credentialsFromUrl('DATABASE_URL', urls.appUrl);
  if (new Set([admin.role, migrator.role, app.role]).size !== 3) {
    throw new DatabaseBootstrapError('admin, migrator and app must be three different roles');
  }
  if (migrator.database !== app.database) {
    throw new DatabaseBootstrapError(
      'DATABASE_MIGRATION_URL and DATABASE_URL must target the same database',
    );
  }
  const databases = [migrator.database, ...(options.extraDatabases ?? [])];
  for (const name of databases) assertIdentifier('database', name);

  await withClient(urls.adminUrl, async (client) => {
    await ensureRole(client, migrator);
    await ensureRole(client, app);
    for (const name of databases) await ensureDatabase(client, name, migrator.role);
  });
  for (const name of databases) {
    await applyGrants(urls.adminUrl, name, migrator.role, app.role);
  }
  return { databases };
}

/** Drops a database (terminating its connections). For disposable test databases only. */
export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  assertIdentifier('database', database);
  await withClient(adminUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`);
  });
}

/** Root of the `@acf/database` package (this file lives in `src/admin` or `dist/admin`). */
const PACKAGE_DIR = path.resolve(import.meta.dirname, '..', '..');

/**
 * Drops and recreates the database named by `urls.migratorUrl` exactly as production builds
 * it: roles and grants, then `prisma migrate deploy` as the migrator, then grants again.
 * For disposable test databases only.
 */
export async function recreateDatabaseFromMigrations(urls: DatabaseRoleUrls): Promise<void> {
  const { database } = credentialsFromUrl('DATABASE_MIGRATION_URL', urls.migratorUrl);
  await dropDatabase(urls.adminUrl, database);
  await bootstrapDatabase(urls);
  await execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_MIGRATION_URL: urls.migratorUrl },
  });
  await bootstrapDatabase(urls); // re-apply grants now that _prisma_migrations exists
}
