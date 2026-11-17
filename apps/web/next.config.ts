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
  // /api/v1/* is forwarded to the API at runtime by src/proxy.ts (same-origin topology, D3).
};

export default nextConfig;
