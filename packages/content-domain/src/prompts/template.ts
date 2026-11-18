import type { LlmMessage } from '@acf/ai-core';
import type { z } from 'zod';

/**
 * A versioned prompt template (CONTENT_PIPELINE §4, M3 design §7.3). The id includes the version
 * (`script.v1`); changing wording means a new version, which changes the execution key.
 */
export interface PromptTemplate<V> {
  readonly id: string;
  /** Strict schema: missing or extra variables fail rendering. */
  readonly variables: z.ZodType<V>;
  build(vars: V): LlmMessage[];
}

export class PromptVariablesError extends Error {
  override readonly name = 'PromptVariablesError';
  constructor(
    readonly templateId: string,
    readonly paths: readonly string[],
  ) {
    super(`invalid variables for prompt ${templateId}: ${paths.join(', ')}`);
  }
}

export interface RenderedPrompt {
  readonly templateId: string;
  readonly messages: LlmMessage[];
  /** The fully resolved prompt, stored on the job (CONTENT_PIPELINE §4). */
  readonly snapshot: string;
}

export function renderPrompt<V>(template: PromptTemplate<V>, vars: unknown): RenderedPrompt {
  const parsed = template.variables.safeParse(vars);
  if (!parsed.success) {
    throw new PromptVariablesError(template.id, [
      ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
    ]);
  }
  const messages = template.build(parsed.data);
  const snapshot = messages.map((m) => `### ${m.role}\n${m.content}`).join('\n\n');
  return { templateId: template.id, messages, snapshot };
}

/**
 * User-supplied text is passed as JSON inside a tagged block, and the system message tells the
 * model to treat it as data, never as instructions (risk S3).
 */
export const dataBlock = (tag: string, value: unknown): string =>
  `<${tag}>\n${JSON.stringify(value, null, 2)}\n</${tag}>`;
