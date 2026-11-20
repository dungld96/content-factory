import { NextResponse, type NextRequest } from 'next/server';

/**
 * Same-origin topology (decision D3, ADR-0009): the browser talks only to this origin; every
 * `/api/v1/*` request is rewritten to the private API.
 *
 * This runs here rather than as `next.config.ts` rewrites because those are frozen into the
 * build output (`routes-manifest.json`), whereas `API_INTERNAL_URL` must be a runtime setting:
 * one build, several environments. Verified on Next.js 16.4.6: request headers (Cookie, Origin,
 * x-csrf-token) are forwarded, `Set-Cookie` is passed back unchanged, `X-Forwarded-For` is
 * appended, and a client-supplied `X-Forwarded-Proto` passes through (otherwise Next sets
 * `http`). The TLS proxy in front of Next.js must therefore overwrite `X-Forwarded-Proto`.
 *
 * Pages get a Content-Security-Policy with a per-request nonce (M8.5 Q8): Next.js reads the
 * policy from the request and puts the nonce on its own scripts, so no other script can run.
 * Inline `style` attributes stay allowed (React `style={…}`); fonts are self-hosted (next/font).
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/v1/')) {
    const base = process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000';
    return NextResponse.rewrite(new URL(request.nextUrl.pathname + request.nextUrl.search, base));
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce, process.env['NODE_ENV'] !== 'production');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    '/api/v1/:path*',
    // Pages only: not static files, images or prefetches (they carry no scripts to protect).
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
