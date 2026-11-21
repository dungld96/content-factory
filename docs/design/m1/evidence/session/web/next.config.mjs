// Same-origin topology (D3): the browser talks only to Next.js, which proxies /api/v1/* to the API.
export default {
  agentRules: false, // stop Next.js from generating AGENTS.md (it leaked into the M0 commit)
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: 'http://127.0.0.1:4100/api/v1/:path*' }];
  },
};
