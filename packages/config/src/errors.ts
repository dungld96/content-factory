import type { z } from 'zod';

export interface EnvIssue {
  /** Environment variable name (or dotted path). */
  readonly key: string;
  /** Human-readable problem. Never contains the offending value. */
  readonly message: string;
}

/**
 * Thrown when environment validation fails.
 *
 * The message lists variable names and problems only — never values — so it
 * is safe to log even when the invalid variable holds a secret.
 */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly issues: readonly EnvIssue[];

  constructor(scope: string, issues: readonly EnvIssue[]) {
    super(
      `Invalid ${scope} environment configuration:\n` +
        issues.map((issue) => `  - ${issue.key}: ${issue.message}`).join('\n'),
    );
    this.issues = issues;
  }
}

export function toEnvIssues(error: z.ZodError): EnvIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}
