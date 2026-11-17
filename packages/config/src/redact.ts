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
