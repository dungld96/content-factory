import { z } from 'zod';

/** URL-safe identifier: lowercase letters, digits and single hyphens (e.g. `ngan-khanh`). */
export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase letters, digits and single hyphens');

/** BCP 47 language tag, canonicalized (e.g. `vi`, `en-US`). */
export const languageTagSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .transform((value, ctx) => {
    try {
      const [canonical] = Intl.getCanonicalLocales(value);
      if (canonical) return canonical;
    } catch {
      // fall through
    }
    ctx.addIssue({ code: 'custom', message: 'must be a valid BCP 47 language tag' });
    return z.NEVER;
  });

/** IANA time zone (e.g. `Asia/Ho_Chi_Minh`, `UTC`). */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid IANA time zone' },
  );

/** Optional free text: trimmed; an empty string clears it (`null`). */
export const optionalTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();

/** `?includeArchived=true` on list endpoints. */
export const includeArchivedSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const isoDateTimeSchema = z.iso.datetime();

/** `{ data: [...] }` wrapper for small, unpaginated collections. */
export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item) });
}
