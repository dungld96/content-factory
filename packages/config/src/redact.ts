/**
 * Returns a URL string safe for logs: username/password removed, query string dropped
 * (query parameters frequently carry tokens such as `?password=` or `?sslkey=`).
 * Unparseable input returns a placeholder instead of the raw value.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const auth = url.username || url.password ? '***@' : '';
    return `${url.protocol}//${auth}${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}

export const REDACTED = '[redacted]';

/**
 * Credential shapes masked wherever they appear in free text (M7 design §10, B10): bearer and
 * basic credentials, API-key-shaped tokens (`sk-…`, `sk-or-v1-…`), credentials embedded in URLs,
 * token-like query parameters (signed URLs) and `key=value` pairs naming a secret.
 */
const TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1***@`],
  [
    /([?&](?:x-amz-[a-z-]+|signature|sig|token|access_token|api_key|apikey|key|password|secret)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
  [
    /\b((?:api[_-]?key|key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi,
    `$1${REDACTED}`,
  ],
];

/** Masks credential-shaped substrings in free text (messages, stacks, provider bodies). */
export function redactSecrets(text: string): string {
  let clean = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) clean = clean.replace(pattern, replacement);
  return clean;
}

/** Field names whose values are never logged, whatever they look like. */
const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|.*token|.*secret|.*password)$/i;

/**
 * Deep copy of a log payload with secrets removed: values of secret-named fields are replaced,
 * every string is passed through {@link redactSecrets}. Cycles and depth are bounded.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message),
      ...(value.stack ? { stack: redactSecrets(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] =
      SECRET_KEY.test(key) && v !== null && v !== undefined ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}
