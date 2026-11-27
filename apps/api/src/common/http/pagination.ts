import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';

import { ApiErrorCode, type Page } from '@acf/contracts';

import { ApiError } from '../api-error.js';

/** Keyset position: rows are ordered by `(createdAt DESC, id DESC)` (design package §8.5). */
export interface CursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

const cursorPayloadSchema = z.strictObject({
  c: z.iso.datetime(),
  i: z.uuid(),
});

/** Opaque cursor: base64url of `{ c: createdAt ISO, i: id }`. */
export function encodeCursor(position: CursorPosition): string {
  const payload = { c: position.createdAt.toISOString(), i: position.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** @throws {ApiError} 400 `INVALID_CURSOR` for anything that is not a cursor we issued. */
export function decodeCursor(cursor: string): CursorPosition {
  const invalid = () =>
    new ApiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCode.InvalidCursor,
      message: 'The pagination cursor is invalid.',
    });
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  return { createdAt: new Date(parsed.data.c), id: parsed.data.i };
}

/**
 * Builds a page from rows fetched with `take: limit + 1`: the extra row only signals that
 * another page exists and is not returned.
 */
export function toPage<Row extends CursorPosition, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    data: visible.map(toItem),
    page: { nextCursor: rows.length > limit && last ? encodeCursor(last) : null, limit },
  };
}

/**
 * Prisma `where` fragment selecting rows strictly after `cursor` in
 * `(createdAt DESC, id DESC)` order. Empty when there is no cursor.
 */
export function keysetAfter(cursor: string | undefined) {
  if (cursor === undefined) return {};
  const { createdAt, id } = decodeCursor(cursor);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}

/** Ordering matching {@link keysetAfter} and the `(…, created_at DESC, id DESC)` indexes. */
export const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
