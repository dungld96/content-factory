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
};

export default nextConfig;
