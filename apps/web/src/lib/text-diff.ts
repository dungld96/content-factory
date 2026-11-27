/**
 * Word-level diff for the review mode (redesign R4): what changed between the previous and the
 * current version of a script or storyboard text. Longest common subsequence over words;
 * whitespace is kept with the word before it. Inputs are short (a few hundred words).
 */
export type DiffPart = { readonly kind: 'same' | 'added' | 'removed'; readonly text: string };

const MAX_WORDS = 1_500;

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = words(before);
  const b = words(after);
  if (a.length > MAX_WORDS || b.length > MAX_WORDS) {
    return before === after
      ? [{ kind: 'same', text: after }]
      : [
          { kind: 'removed', text: before },
          { kind: 'added', text: after },
        ];
  }
  const norm = (w: string) => w.trim();
  // lcs[i][j] = LCS length of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        norm(a[i] ?? '') === norm(b[j] ?? '')
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (norm(a[i] ?? '') === norm(b[j] ?? '')) {
      push('same', b[j] ?? '');
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      push('removed', a[i] ?? '');
      i++;
    } else {
      push('added', b[j] ?? '');
      j++;
    }
  }
  while (i < a.length) push('removed', a[i++] ?? '');
  while (j < b.length) push('added', b[j++] ?? '');
  return parts;
}

/** Whether anything changed. */
export const hasChanges = (parts: readonly DiffPart[]) => parts.some((p) => p.kind !== 'same');
