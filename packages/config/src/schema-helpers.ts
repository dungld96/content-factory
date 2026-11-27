import { z } from 'zod';

/** Accepts only URLs whose protocol is in `protocols` (e.g. `['postgres:', 'postgresql:']`). */
export function urlWithProtocol(protocols: readonly string[], label: string) {
  return z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `must be a valid URL using one of: ${protocols.join(', ')}` },
    );
}

export const portSchema = z.coerce
  .number({ error: 'must be a number' })
  .int('must be an integer')
  .min(1, 'must be between 1 and 65535')
  .max(65535, 'must be between 1 and 65535');

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])
  .default('log');

/** Parses "true"/"false"/"1"/"0" strings. `z.coerce.boolean()` treats "false" as true, so avoid it. */
export const booleanStringSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');
