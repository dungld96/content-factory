import { PrismaPg } from '@prisma/adapter-pg';

import { Prisma, PrismaClient } from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  /** PostgreSQL connection string. Must come from validated configuration. */
  readonly databaseUrl: string;
  /** Maximum pooled connections for this process. */
  readonly maxConnections?: number;
  /** Milliseconds to wait for a pooled connection before failing. */
  readonly connectionTimeoutMs?: number;
}

/**
 * Creates a Prisma client backed by the `pg` driver adapter (required by Prisma 7).
 *
 * Construction does not open a connection; the pool connects lazily on first query.
 * Callers own the lifecycle and must call `$disconnect()` on shutdown.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });
  return new PrismaClient({ adapter });
}

export { Prisma, PrismaClient };

/** The client handed to an interactive `$transaction` callback. */
export type TransactionClient = Prisma.TransactionClient;
