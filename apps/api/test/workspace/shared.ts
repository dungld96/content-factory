import type pg from 'pg';

import type { PrismaClient } from '@acf/database';

import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import type { CallResult } from '../support/http-client.js';
import { actAs, createFixture, seedUsers, signInAll, type Fixture } from '../support/workspace.js';

export interface WorkspaceContext {
  api: AuthTestApp;
  db: pg.Client;
  prisma: PrismaClient;
  ids: Record<string, string>;
  as: ReturnType<typeof actAs>;
  fixture: () => Promise<Fixture>;
  close: () => Promise<void>;
}

export async function workspaceContext(): Promise<WorkspaceContext> {
  const db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  const ids = await seedUsers(admin.users);
  const api = await startAuthApp();
  const as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
  return {
    api,
    db,
    prisma: admin.prisma,
    ids,
    as,
    fixture: () => createFixture(db, ids),
    close: async () => {
      await api.close();
      await admin.prisma.$disconnect();
      await db.end();
    },
  };
}

export const codeOf = (res: CallResult) =>
  (res.json as { error?: { code?: string } } | null)?.error?.code;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test accessor
export const bodyOf = <T>(res: CallResult) => res.json as T;
