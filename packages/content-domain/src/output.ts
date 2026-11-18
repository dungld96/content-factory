import type { z } from 'zod';

import type { RuleIssue } from './issues.js';

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly repairedDeterministically: boolean }
  | {
      readonly ok: false;
      /** `json`: not parseable JSON; `schema`: wrong shape; `rules`: domain rules failed. */
      readonly stage: 'json' | 'schema' | 'rules';
      readonly issues: readonly RuleIssue[];
      /** The JSON text that was parsed (for a repair call), when one was found. */
      readonly json: string | null;
    };

/**
 * Deterministic repair only (M3 design §7.4 step 1): strip one Markdown code fence, or take the
 * text from the first `{` to the last `}`. Returns null when no object-like text exists.
 */
export function extractJsonObject(text: string): { json: string; changed: boolean } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return { json: trimmed, changed: false };
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fence?.[1] !== undefined) {
    const inner = fence[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) return { json: inner, changed: true };
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return { json: trimmed.slice(start, end + 1), changed: true };
}

const zodIssues = (error: z.ZodError): RuleIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

/**
 * Parses model output against a schema and domain rules. Never throws on bad output; the caller
 * decides between one repair call and `OUTPUT_INVALID` (decision Q5).
 */
export function parseModelOutput<T>(
  text: string,
  schema: z.ZodType<T>,
  rules: (value: T) => readonly RuleIssue[],
): ParseOutcome<T> {
  const extracted = extractJsonObject(text);
  if (!extracted) {
    return {
      ok: false,
      stage: 'json',
      issues: [{ path: '', message: 'no JSON object found' }],
      json: null,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted.json);
  } catch (error) {
    return {
      ok: false,
      stage: 'json',
      issues: [
        {
          path: '',
          message: `invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
        },
      ],
      json: extracted.json,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, stage: 'schema', issues: zodIssues(parsed.error), json: extracted.json };
  }
  const ruleIssues = rules(parsed.data);
  if (ruleIssues.length > 0) {
    return { ok: false, stage: 'rules', issues: ruleIssues, json: extracted.json };
  }
  return { ok: true, value: parsed.data, repairedDeterministically: extracted.changed };
}
