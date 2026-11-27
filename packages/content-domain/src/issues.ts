/** A validation problem at a JSON path. Never contains the offending content itself. */
export interface RuleIssue {
  readonly path: string;
  readonly message: string;
}

/** At most this many issues are reported (and sent to a repair call). */
export const MAX_REPORTED_ISSUES = 20;

export function formatIssues(issues: readonly RuleIssue[]): string[] {
  return issues.slice(0, MAX_REPORTED_ISSUES).map((i) => `${i.path || '(root)'}: ${i.message}`);
}
