import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { UserAdminService } from '../../src/users/user-admin.service.js';
import { PASSWORD } from './auth-app.js';
import { client, CookieJar, type CallOptions, type CallResult } from './http-client.js';

export type Persona = 'owner' | 'editor' | 'viewer' | 'outsider';
export const PERSONAS: readonly Persona[] = ['owner', 'editor', 'viewer', 'outsider'];

export const emailOf = (who: Persona | 'target' | 'invitee') => `${who}@example.test`;

export interface Session {
  readonly jar: CookieJar;
  readonly csrf: string;
  readonly userId: string;
}

/** Creates the personas plus `target` (a member others act on) and `invitee` (never a member). */
export async function seedUsers(users: UserAdminService): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const who of [...PERSONAS, 'target', 'invitee'] as const) {
    ids[who] = (
      await users.create({ email: emailOf(who), displayName: who, password: PASSWORD })
    ).id;
  }
  return ids;
}

/** Signs in every persona once; `null` is the unauthenticated caller. */
export async function signInAll(baseUrl: string, ids: Record<string, string>) {
  const call = client(baseUrl);
  const sessions: Partial<Record<Persona, Session>> = {};
  for (const who of PERSONAS) {
    const jar = new CookieJar();
    const res = await call(jar, 'POST', '/auth/login', {
      body: { email: emailOf(who), password: PASSWORD },
    });
    if (res.status !== 200) throw new Error(`login failed for ${who}: ${res.status}`);
    sessions[who] = {
      jar,
      csrf: (res.json as { csrfToken: string }).csrfToken,
      userId: ids[who] ?? '',
    };
  }
  return sessions as Record<Persona, Session>;
}

/** Calls as a persona (with its CSRF token) or unauthenticated (`null`). */
export function actAs(baseUrl: string, sessions: Record<Persona, Session>) {
  const call = client(baseUrl);
  return (
    who: Persona | null,
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<CallResult> => {
    const session = who ? sessions[who] : null;
    return call(session?.jar ?? null, method, path, {
      ...options,
      headers: { ...(session ? { 'x-csrf-token': session.csrf } : {}), ...options.headers },
    });
  };
}

export interface Fixture {
  readonly projectId: string;
  readonly channelId: string;
  readonly contentId: string;
}

/**
 * A fresh project via SQL (as the migrator): owner/editor/viewer personas plus `target`
 * (editor), one channel and one content item. `outsider` and `invitee` are not members.
 */
export async function createFixture(db: pg.Client, ids: Record<string, string>): Promise<Fixture> {
  const projectId = randomUUID();
  const channelId = randomUUID();
  const contentId = randomUUID();
  const slug = `p-${projectId.slice(0, 8)}`;
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'Fixture', '${slug}', 'vi', 'Asia/Ho_Chi_Minh', '${ids['owner']}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
      ('${projectId}', '${ids['owner']}', 'owner', now()),
      ('${projectId}', '${ids['editor']}', 'editor', now()),
      ('${projectId}', '${ids['viewer']}', 'viewer', now()),
      ('${projectId}', '${ids['target']}', 'editor', now());
    INSERT INTO channels (id, project_id, name, slug, platform, created_by_id, updated_at)
      VALUES ('${channelId}', '${projectId}', 'Main', 'main', 'tiktok', '${ids['owner']}', now());
    INSERT INTO content_items (id, project_id, channel_id, title, format, target_duration_seconds,
        aspect_ratio, language, brief, created_by_id, updated_at)
      VALUES ('${contentId}', '${projectId}', '${channelId}', 'Desk gadgets', 'short_video', 30, '9:16',
        'vi', '{"topic":"Desk gadgets"}', '${ids['owner']}', now());
    COMMIT`);
  return { projectId, channelId, contentId };
}

export const validBrief = { topic: 'Useful desk gadgets', audience: 'Office workers' };
export const newContent = (channelId?: string) => ({
  title: '5 useful desk gadgets',
  ...(channelId ? { channelId } : {}),
  format: 'short_video',
  targetDurationSeconds: 30,
  aspectRatio: '9:16',
  language: 'vi',
  brief: validBrief,
});
