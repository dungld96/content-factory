import path from 'node:path';

// Integration tests read DATABASE_URL / REDIS_URL from the shell or the repository-root .env.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../.env'));
} catch {
  // No .env present: rely on the process environment (e.g. CI service containers).
}
