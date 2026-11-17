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
 */
export function proxy(request: NextRequest): NextResponse {
  const base = process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000';
  return NextResponse.rewrite(new URL(request.nextUrl.pathname + request.nextUrl.search, base));
}

export const config = { matcher: '/api/v1/:path*' };
