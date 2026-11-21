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

/** Value constraints a `basic` provider does not receive (M8.5 Q2); the local schema still enforces them. */
const VALUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

/**
 * The structure of a JSON Schema without value constraints (types, properties, required, enums,
 * `additionalProperties`, `anyOf`): for providers whose structured-output engine rejects complex
 * schemas (pilot F1: Gemini 3.5 Flash Lite and the storyboard schema). Property names are kept
 * even when they equal a constraint keyword.
 */
export function basicJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const strip = (node: unknown, inProperties: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => strip(n, false));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!inProperties && VALUE_CONSTRAINTS.has(key)) continue;
      out[key] = strip(
        value,
        !inProperties && (key === 'properties' || key === '$defs' || key === 'definitions'),
      );
    }
    return out;
  };
  return strip(schema, false) as Record<string, unknown>;
}
