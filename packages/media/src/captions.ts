/**
 * Captions for renders (M6 design §6): the narration text of each scene split into short cues,
 * timed per scene from the measured voice-over duration (no speech recognition), written as SRT
 * (delivered) and ASS (burned in). Pure: no I/O.
 */

export interface CaptionCue {
  readonly startMs: number;
  readonly endMs: number;
  /** One or two lines. */
  readonly lines: readonly string[];
}

export interface CaptionScene {
  /** Where the scene starts in the render. */
  readonly startMs: number;
  /** The voice-over text of the scene ('' = no narration, no cue). */
  readonly text: string;
  /** How long the narration lasts (the measured voice-over), ≤ the scene. */
  readonly speechMs: number;
}

export const CAPTION_MAX_LINES = 2;
export const CAPTION_MAX_CHARS = 32;

const charCount = (s: string) => Array.from(s).length;

/** Punctuation that ends a phrase: a caption may break after it (M8.5 Q7). */
const PHRASE_END = /[.,!?;:…)\]"”»]$/u;
/** A tail this short (in words) is merged into or balanced with its neighbour. */
const SHORT_TAIL_WORDS = 3;
/** Cues shorter than this are merged with a neighbour of the same scene when the text fits. */
export const CAPTION_MIN_CUE_MS = 1000;

const join = (words: readonly string[]) => words.join(' ');

/** Splits text into phrases (word lists) after punctuation. */
function phrasesOf(text: string): string[][] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const phrases: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    if (PHRASE_END.test(word)) {
      phrases.push(current);
      current = [];
    }
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
}

/**
 * Wraps words into at most `maxLines` lines of ≤ maxChars, as evenly as possible and preferring a
 * break right after punctuation; null when they do not fit. A single word longer than maxChars
 * gets a line of its own.
 */
function wrapBalanced(
  words: readonly string[],
  maxChars: number,
  maxLines: number,
): string[] | null {
  const whole = join(words);
  if (charCount(whole) <= maxChars || words.length === 1) return [whole];
  if (maxLines < 2) return null;
  let best: { lines: string[]; score: number } | null = null;
  for (let k = 1; k < words.length; k += 1) {
    const first = join(words.slice(0, k));
    const rest = wrapBalanced(words.slice(k), maxChars, maxLines - 1);
    if (!rest) continue;
    const firstOk = charCount(first) <= maxChars || k === 1;
    if (!firstOk) break;
    const lengths = [first, ...rest].map(charCount);
    const spread = Math.max(...lengths) - Math.min(...lengths);
    const atPhrase = PHRASE_END.test(words[k - 1] ?? '') ? 14 : 0;
    const score = spread - atPhrase;
    if (!best || score < best.score) best = { lines: [first, ...rest], score };
  }
  return best?.lines ?? null;
}

/** Greedy word cues for a phrase that does not fit one cue. */
function greedyCues(words: readonly string[], maxChars: number, maxLines: number): string[][] {
  const cues: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    const next = [...current, word];
    if (current.length > 0 && !wrapBalanced(next, maxChars, maxLines)) {
      cues.push(current);
      current = [word];
    } else {
      current = next;
    }
  }
  if (current.length > 0) cues.push(current);
  return cues;
}

/**
 * Narration text to caption cues (each a list of lines): whole phrases are kept together and
 * packed while they fit `maxLines` × `maxChars`; lines are balanced and break after punctuation
 * where possible; a short tail is merged into, or balanced with, the previous cue.
 */
export function chunkCaptionText(
  text: string,
  maxChars = CAPTION_MAX_CHARS,
  maxLines = CAPTION_MAX_LINES,
): string[][] {
  const cueWords: string[][] = [];
  let current: string[] = [];
  for (const phrase of phrasesOf(text)) {
    const together = [...current, ...phrase];
    if (wrapBalanced(together, maxChars, maxLines)) {
      current = together;
      continue;
    }
    if (current.length > 0) cueWords.push(current);
    if (wrapBalanced(phrase, maxChars, maxLines)) {
      current = [...phrase];
    } else {
      const parts = greedyCues(phrase, maxChars, maxLines);
      cueWords.push(...parts.slice(0, -1));
      current = parts.at(-1) ?? [];
    }
  }
  if (current.length > 0) cueWords.push(current);

  // A short tail (e.g. "nhé.") joins the previous cue when it fits; otherwise words move over
  // from the previous cue so both read as phrases of similar length.
  if (cueWords.length >= 2) {
    const last = cueWords[cueWords.length - 1] ?? [];
    const prev = cueWords[cueWords.length - 2] ?? [];
    if (last.length <= SHORT_TAIL_WORDS) {
      const merged = [...prev, ...last];
      if (wrapBalanced(merged, maxChars, maxLines)) {
        cueWords.splice(-2, 2, merged);
      } else {
        let a = prev;
        let b = last;
        while (a.length > SHORT_TAIL_WORDS && b.length <= SHORT_TAIL_WORDS) {
          const moved = [a[a.length - 1] ?? '', ...b];
          if (!wrapBalanced(moved, maxChars, maxLines)) break;
          a = a.slice(0, -1);
          b = moved;
        }
        cueWords.splice(-2, 2, a, b);
      }
    }
  }
  return cueWords.map(
    (words) => wrapBalanced(words, maxChars, maxLines) ?? greedyCues(words, maxChars, 1).map(join),
  );
}

/**
 * Cues of every scene; each scene's cues share its speech time in proportion to characters. A cue
 * shorter than {@link CAPTION_MIN_CUE_MS} is merged with its neighbour in the same scene when the
 * text fits.
 */
export function buildCaptionCues(scenes: readonly CaptionScene[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const scene of scenes) {
    let chunks = chunkCaptionText(scene.text);
    if (chunks.length === 0 || scene.speechMs <= 0) continue;
    const timed = () => {
      const weights = chunks.map((c) => charCount(c.join(' ')));
      const total = weights.reduce((a, b) => a + b, 0);
      let used = 0;
      return chunks.map((_, i) => {
        const startUsed = used;
        used += weights[i] ?? 0;
        return {
          startMs: scene.startMs + Math.round((scene.speechMs * startUsed) / total),
          endMs:
            i === chunks.length - 1
              ? scene.startMs + scene.speechMs
              : scene.startMs + Math.round((scene.speechMs * used) / total),
        };
      });
    };
    let times = timed();
    for (let guard = 0; guard < 10; guard += 1) {
      const short = times.findIndex((t) => t.endMs - t.startMs < CAPTION_MIN_CUE_MS);
      if (short < 0 || chunks.length < 2) break;
      const other = short === chunks.length - 1 ? short - 1 : short + 1;
      const [a, b] = [Math.min(short, other), Math.max(short, other)];
      const merged = wrapBalanced(
        [...(chunks[a] ?? []), ...(chunks[b] ?? [])].join(' ').split(' '),
        CAPTION_MAX_CHARS,
        CAPTION_MAX_LINES,
      );
      if (!merged) break;
      chunks = [...chunks.slice(0, a), merged, ...chunks.slice(b + 1)];
      times = timed();
    }
    chunks.forEach((lines, i) => {
      const t = times[i];
      if (t) cues.push({ startMs: t.startMs, endMs: t.endMs, lines });
    });
  }
  return cues;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function clock(ms: number, separator: ',' | '.', fractionDigits: 2 | 3): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const fraction = fractionDigits === 3 ? total % 1000 : Math.floor((total % 1000) / 10);
  return `${pad(h, fractionDigits === 3 ? 2 : 1)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(fraction, fractionDigits)}`;
}

/** SubRip text: numbered cues, `HH:MM:SS,mmm` times, CRLF-free UTF-8. */
export function toSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map(
      (c, i) =>
        `${String(i + 1)}\n${clock(c.startMs, ',', 3)} --> ${clock(c.endMs, ',', 3)}\n${c.lines.join('\n')}\n`,
    )
    .join('\n');
}

export interface SrtCheck {
  readonly cues: number;
  readonly issues: readonly string[];
}

const SRT_TIME = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

/** Re-parses SRT: sequential numbers, valid times, start < end, no overlap, within `maxMs`. */
export function checkSrt(srt: string, maxMs: number): SrtCheck {
  const issues: string[] = [];
  const blocks = srt.trim() ? srt.trim().split(/\n\n+/) : [];
  let previousEnd = -1;
  blocks.forEach((block, i) => {
    const [num, time, ...text] = block.split('\n');
    if (num !== String(i + 1)) issues.push(`cue ${String(i + 1)}: bad sequence number`);
    const m = SRT_TIME.exec(time ?? '');
    if (!m) {
      issues.push(`cue ${String(i + 1)}: bad time line`);
      return;
    }
    const n = m.slice(1).map(Number);
    const at = (h = 0, mi = 0, s = 0, ms = 0) => ((h * 60 + mi) * 60 + s) * 1000 + ms;
    const start = at(n[0], n[1], n[2], n[3]);
    const end = at(n[4], n[5], n[6], n[7]);
    if (start >= end) issues.push(`cue ${String(i + 1)}: ends before it starts`);
    if (start < previousEnd) issues.push(`cue ${String(i + 1)}: overlaps the previous cue`);
    if (end > maxMs + 1) issues.push(`cue ${String(i + 1)}: ends after the video`);
    if (text.join('').trim() === '') issues.push(`cue ${String(i + 1)}: no text`);
    previousEnd = end;
  });
  return { cues: blocks.length, issues };
}

/** Text safe inside an ASS dialogue line: no override blocks, no escapes, explicit breaks. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '⧵') // a reverse solidus lookalike: ASS has no escape for "\"
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/[\r\n]+/g, ' ');
}

export interface AssStyle {
  readonly font: string;
  readonly fontSize: number;
  readonly width: number;
  readonly height: number;
  /** Baseline of the caption block as a fraction of the height from the top (e.g. 0.72). */
  readonly verticalPosition: number;
}

export const DEFAULT_CAPTION_STYLE: AssStyle = {
  font: 'Be Vietnam Pro SemiBold',
  fontSize: 64,
  width: 1080,
  height: 1920,
  verticalPosition: 0.72,
};

/** Advanced SubStation script for the `subtitles` filter (burn-in). */
export function toAss(
  cues: readonly CaptionCue[],
  style: AssStyle = DEFAULT_CAPTION_STYLE,
): string {
  const marginV = Math.round(style.height * (1 - style.verticalPosition));
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${String(style.width)}`,
    `PlayResY: ${String(style.height)}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // White text, dark outline and shadow, bottom-centred (alignment 2) above the platform UI.
    `Style: Caption,${style.font},${String(style.fontSize)},&H00FFFFFF,&H00FFFFFF,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,4,2,2,60,60,${String(marginV)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map(
    (c) =>
      `Dialogue: 0,${clock(c.startMs, '.', 2)},${clock(c.endMs, '.', 2)},Caption,,0,0,0,,${c.lines
        .map(escapeAssText)
        .join('\\N')}`,
  );
  return `${[...header, ...events].join('\n')}\n`;
}
