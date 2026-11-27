// Network guard for every Vitest project (M2 design package §9): `fetch` may reach loopback
// hosts only (local fixture servers, the API under test). Any other host, such as
// openrouter.ai, fails the test instead of making a real, possibly paid, call.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const realFetch = globalThis.fetch;

function hostOf(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).hostname;
}

globalThis.fetch = (input, init) => {
  const host = hostOf(input);
  if (!LOOPBACK.has(host)) {
    return Promise.reject(
      new Error(`network guard: tests may not call ${host} (loopback only; CLAUDE.md §9)`),
    );
  }
  return realFetch(input, init);
};
