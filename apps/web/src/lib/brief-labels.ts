/** Readable names for the brief fields that brief checks report (UX review D2). */
const LABELS: Readonly<Record<string, string>> = {
  'brief.topic': 'Topic',
  'brief.audience': 'Audience',
  'brief.objective': 'Objective',
  'brief.tone': 'Tone',
  'brief.callToAction': 'Call to action',
  'brief.notes': 'Notes',
  'brief.sourceUrls': 'Sources',
  'brief.characterId': 'Character',
  'brief.environmentId': 'Environment',
  targetDurationSeconds: 'Duration',
};

/** "Audience" for `brief.audience`; unknown paths keep their last segment, capitalised. */
export function briefFieldLabel(path: string): string {
  const known = LABELS[path];
  if (known) return known;
  const last = path.split('.').pop() ?? path;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One sentence for a brief issue: "Audience not set: the model will choose." */
export function briefIssueText(issue: { readonly path: string; readonly message: string }): string {
  const message = issue.message.replace(/^not set; /, 'not set: ');
  return `${briefFieldLabel(issue.path)} ${message}.`;
}
