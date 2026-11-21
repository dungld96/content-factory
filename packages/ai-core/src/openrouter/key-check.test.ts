// Contract test for the free key check (P1 design O3) against a local fixture server: only
// `GET /key` is called, with the bearer key; every response class maps to a result.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checkOpenRouterKey } from './key-check.js';

const KEY = 'sk-or-v1-0000000000000000000000000000beef';
let server: Server;
let baseUrl: string;
let reply: { status: number; body: string };
let seen: { method: string | undefined; url: string | undefined; auth: string | undefined }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
});

const config = () => ({ apiKey: KEY, baseUrl, timeoutMs: 5000 });

describe('checkOpenRouterKey', () => {
  it('reads the documented fields of a valid key with one GET /key', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        data: { label: 'sk-or-v1-000…eef', limit_remaining: 7.5, usage: 2.25, is_free_tier: false },
      }),
    };
    expect(await checkOpenRouterKey(config())).toEqual({
      result: 'valid',
      httpStatus: 200,
      limitRemaining: 7.5,
      usage: 2.25,
      isFreeTier: false,
    });
    expect(seen).toEqual([{ method: 'GET', url: '/api/v1/key', auth: `Bearer ${KEY}` }]);
  });

  it('accepts a valid key whose answer lacks the fields (none is required)', async () => {
    reply = { status: 200, body: JSON.stringify({ data: { limit: null } }) };
    expect(await checkOpenRouterKey(config())).toMatchObject({
      result: 'valid',
      limitRemaining: null,
      usage: null,
      isFreeTier: null,
    });
  });

  it('reports a rejected key', async () => {
    reply = { status: 401, body: JSON.stringify({ error: { code: 401, message: 'No auth' } }) };
    expect(await checkOpenRouterKey(config())).toMatchObject({
      result: 'rejected',
      httpStatus: 401,
    });
  });

  it('reports other statuses and network errors as unreachable', async () => {
    reply = { status: 503, body: '' };
    expect(await checkOpenRouterKey(config())).toMatchObject({
      result: 'unreachable',
      httpStatus: 503,
    });
    expect(
      await checkOpenRouterKey({ ...config(), baseUrl: 'http://127.0.0.1:9/api/v1' }),
    ).toMatchObject({ result: 'unreachable', httpStatus: null });
  });
});
