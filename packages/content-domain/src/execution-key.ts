import { createHash } from 'node:crypto';

/** Every input that determines a generation's result (CONTENT_PIPELINE §3, M3 design §7.5). */
export interface ExecutionKeyInput {
  readonly kind: 'script_generation' | 'storyboard_generation';
  readonly contentItemId: string;
  /** The normalized brief and generation settings (duration, language, aspect ratio). */
  readonly brief: unknown;
  /** Input version ids: approved script, character/environment masters, reference assets. */
  readonly inputVersionIds: readonly string[];
  /** Prompt template id with version, e.g. `script.v1`. */
  readonly promptTemplateId: string;
  readonly modelId: string;
}

/** Canonical JSON: object keys sorted recursively, so equal inputs hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the canonical inputs. Prices are deliberately not part of the key. */
export function executionKey(input: ExecutionKeyInput): string {
  const payload = canonicalJson({ ...input, inputVersionIds: [...input.inputVersionIds].sort() });
  return createHash('sha256').update(payload).digest('hex');
}
