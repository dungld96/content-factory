import { z } from 'zod';

/**
 * JSON Schema for a zod schema, as sent in `response_format` (M3 design §5.3). Generated from the
 * same schema that validates the output, so request and validator cannot diverge. `$schema` is
 * dropped: some providers reject unknown top-level keywords in strict mode.
 */
export function toResponseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { target: 'draft-2020-12' }) };
  delete json['$schema'];
  return json;
}
