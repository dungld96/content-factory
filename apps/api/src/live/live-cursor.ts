/**
 * Live event cursors (redesign R-D5): `<createdAt ms, 13 digits>-<job event id>`. Ordered by
 * time; readers re-read an overlap window and de-duplicate by id, because event ids are
 * generated before their transaction commits.
 */
export const OVERLAP_MS = 5_000;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

export function cursorOf(createdAt: Date, id: string): string {
  return `${String(createdAt.getTime()).padStart(13, '0')}-${id}`;
}

/** The cursor of "now", when no event has been seen yet. */
export function nowCursor(now = new Date()): string {
  return cursorOf(now, ZERO_ID);
}

/** The time of a cursor, or `null` when it is malformed. */
export function cursorTime(cursor: string): Date | null {
  const match = /^(\d{13})-[0-9a-f-]{36}$/.exec(cursor);
  if (!match?.[1]) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
