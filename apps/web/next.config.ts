import path from 'node:path';

import type { NextConfig } from 'next';

// Local development convenience: load the repository-root .env (Next.js only reads .env files
// from apps/web). Variables already set in the environment take precedence. Server-side only:
// nothing here is inlined into client bundles because no variable is prefixed NEXT_PUBLIC_.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  // No root .env (CI, containers): use the process environment.
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Stop Next.js from generating AGENTS.md (it leaked into the M0 commit; verified in M1 design).
  agentRules: false,
  experimental: {
    // The proxy buffers request bodies and silently truncates beyond this size. Image uploads are
    // up to 25 MB (API UPLOAD_MAX_IMAGE_BYTES, M4a); larger bodies keep their Content-Length and
    // are refused by the API with 413 before it reads them.
    proxyClientMaxBodySize: '26mb',
  },
  // Redesign R1: the content library and the pipeline became Productions (list / board). The
  // content workspace keeps its /content/[id] address. Query strings are carried over.
  redirects() {
    return Promise.resolve([
      { source: '/content', destination: '/productions', permanent: true },
      { source: '/pipeline', destination: '/productions?view=board', permanent: true },
    ]);
  },
  // /api/v1/* is forwarded to the API at runtime by src/proxy.ts (same-origin topology, D3).
};

export default nextConfig;
