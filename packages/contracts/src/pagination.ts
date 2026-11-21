import { z } from 'zod';

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

/** Query parameters of every paginated list endpoint (design package §8.5). */
export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  /** Opaque cursor from a previous response's `page.nextCursor`. */
  cursor: z.string().min(1).max(512).optional(),
});
export type PaginationQuery = z.output<typeof paginationQuerySchema>;

export const pageInfoSchema = z.object({
  /** `null` when this is the last page. */
  nextCursor: z.string().nullable(),
  limit: z.number().int(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

/** `{ data, page }` response wrapper for a list of `item`. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), page: pageInfoSchema });
}
export interface Page<T> {
  readonly data: T[];
  readonly page: PageInfo;
}
