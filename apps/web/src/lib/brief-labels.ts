import type { MessageKey, Translate } from './i18n';

/** Readable names for the brief fields that brief checks report (UX review D2). */
const LABELS: Readonly<Record<string, MessageKey>> = {
  'brief.topic': 'bl.topic',
  'brief.audience': 'bl.audience',
  'brief.objective': 'bl.objective',
  'brief.tone': 'bl.tone',
  'brief.callToAction': 'bl.callToAction',
  'brief.notes': 'bl.notes',
  'brief.sourceUrls': 'bl.sourceUrls',
  'brief.characterId': 'bl.characterId',
  'brief.environmentId': 'bl.environmentId',
  'brief.productAssetIds': 'bl.productAssetIds',
  targetDurationSeconds: 'bl.duration',
};

/** "Audience" for `brief.audience`; unknown paths keep their last segment, capitalised. */
export function briefFieldLabel(path: string, t: Translate): string {
  const known = LABELS[path] ?? LABELS[path.replace(/\.\d+$/, '')];
  if (known) return t(known);
  const last = path.split('.').pop() ?? path;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One sentence for a brief issue in the interface language: "Audience not set: the model will
 * choose." The API's messages (content-domain `validateBrief`) are English; the known ones are
 * translated, any other keeps the field name and the message as sent.
 */
export function briefIssueText(
  issue: { readonly path: string; readonly message: string },
  t: Translate,
): string {
  const field = briefFieldLabel(issue.path, t);
  const { message } = issue;
  if (message === 'is required') return t('bl.required', { field });
  if (message === 'not set; the model will choose') return t('bl.notSet', { field });
  if (/has no approved master version$/.test(message)) return t('bl.noMaster', { field });
  if (message.startsWith('claim-like terms without sources')) return t('bl.claims');
  const range = /^must be (\d+)–(\d+) s for a short video$/.exec(message);
  if (range) return t('bl.duration.range', { min: range[1] ?? '', max: range[2] ?? '' });
  return t('bl.other', { field, message });
}
