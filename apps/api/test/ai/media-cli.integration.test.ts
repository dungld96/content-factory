// M5b operator CLI: video/TTS catalog imports and the paid smoke runs, against a local fixture
// server that plays OpenRouter's documented endpoints (verification record docs/design/m5/).
// Real MP4/MP3 bytes (FFmpeg) flow through download and FFprobe validation; nothing reaches the
// network (loopback only) and no real money is involved.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@acf/database';
import { synthTone, synthVideo } from '@acf/media';

import { runAiRegistryCli } from '../../src/cli/ai-registry-cli.js';
import { TTS_CATALOG_SNAPSHOT, VIDEO_CATALOG_SNAPSHOT } from '../../src/cli/seed-media-snapshot.js';
import { inspector, resetDatabase, userAdmin } from '../support/auth-app.js';
import { seedUsers } from '../support/workspace.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const JOB = 'gen-vid-1763530000-abcdefghij0123456789';

let server: Server;
let baseUrl: string;
let db: pg.Client;
let prisma: PrismaClient;
let projectSlug: string;
let dir: string;
let mp4: Buffer;
let mp3: Buffer;
const requests: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
let polls = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'acf-media-cli-'));
  await synthVideo({ out: path.join(dir, 'clip.mp4'), width: 360, height: 640, durationSec: 4 });
  await synthTone({ out: path.join(dir, 'tone.mp3'), durationSec: 1 });
  mp4 = await readFile(path.join(dir, 'clip.mp4'));
  mp3 = await readFile(path.join(dir, 'tone.mp3'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        url,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      });
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
        return true;
      };
      if (req.method === 'GET' && url === '/api/v1/videos/models') {
        return json(200, { data: VIDEO_CATALOG_SNAPSHOT });
      }
      if (req.method === 'GET' && url === '/api/v1/models?output_modalities=speech') {
        return json(200, { data: TTS_CATALOG_SNAPSHOT });
      }
      if (req.method === 'POST' && url === '/api/v1/videos') {
        return json(202, { id: JOB, polling_url: `${baseUrl}/videos/${JOB}`, status: 'pending' });
      }
      if (req.method === 'GET' && url === `/api/v1/videos/${JOB}`) {
        polls += 1;
        return json(
          200,
          polls < 2
            ? { id: JOB, polling_url: 'x', status: 'in_progress' }
            : {
                id: JOB,
                polling_url: 'x',
                status: 'completed',
                unsigned_urls: ['x'],
                usage: { cost: 0.18 },
              },
        );
      }
      if (req.method === 'GET' && url === `/api/v1/videos/${JOB}/content?index=0`) {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(mp4);
        return;
      }
      if (req.method === 'POST' && url === '/api/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-tts-1' });
        res.end(mp3);
        return;
      }
      if (req.method === 'GET' && url === '/api/v1/generation?id=gen-tts-1') {
        return json(200, { data: { id: 'gen-tts-1', total_cost: 0.0042 } });
      }
      json(404, { error: { code: 404, message: 'not found' } });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`;

  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  const projectId = randomUUID();
  projectSlug = `media-${projectId.slice(0, 8)}`;
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'Media smoke', '${projectSlug}', 'vi', 'UTC', '${ids['owner'] ?? ''}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at)
      VALUES ('${projectId}', '${ids['owner'] ?? ''}', 'owner', now());
    COMMIT`);
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await prisma.$disconnect();
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  polls = 0;
});

const apiEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
  REDIS_URL: 'redis://127.0.0.1:1',
  SESSION_SECRETS: 'test-session-secret-0123456789abcdef',
  CSRF_SECRET: 'test-csrf-secret-0123456789abcdef!!',
};

async function cli(args: readonly string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAiRegistryCli(
    args,
    prisma,
    { OPENROUTER_BASE_URL: baseUrl, ...env },
    {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('model import-openrouter-videos / -tts', () => {
  it('plans without writing, then imports disabled models with constraints and prices', async () => {
    const dry = await cli(['model', 'import-openrouter-videos', 'google/veo-3.1-lite', 'nope/x']);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('output_video_seconds[720p-silent]=0.03');
    expect(dry.out).toContain('durations [4, 6, 8] s');
    expect(dry.out).toContain('✖ nope/x: not in the video catalog');
    expect(await prisma.aiModel.count({ where: { modelKey: 'google/veo-3.1-lite' } })).toBe(0);

    const applied = await cli([
      'model',
      'import-openrouter-videos',
      'google/veo-3.1-lite',
      'alibaba/wan-3.0',
      '--tier',
      'balanced',
      '--apply',
    ]);
    expect(applied.code).toBe(0);
    const veo = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'google/veo-3.1-lite' },
      include: { capabilities: true, prices: true },
    });
    expect(veo.status).toBe('disabled');
    expect(veo.capabilities.map((c) => c.capability)).toEqual(['video_generation']);
    expect(veo.mediaConstraints).toMatchObject({ kind: 'video', durations: [4, 6, 8] });
    expect(veo.prices.map((p) => [p.metric, p.variant, p.unitPrice.toString()]).sort()).toEqual([
      ['output_video_seconds', '720p-audio', '0.05'],
      ['output_video_seconds', '720p-silent', '0.03'],
      ['output_video_seconds', 'audio', '0.08'],
      ['output_video_seconds', 'silent', '0.05'],
    ]);
    const again = await cli([
      'model',
      'import-openrouter-videos',
      'google/veo-3.1-lite',
      '--apply',
    ]);
    expect(again.out).toContain('unchanged, 0 new price row(s)');

    const tts = await cli([
      'model',
      'import-openrouter-tts',
      'elevenlabs/eleven-flash-v2.5',
      '--tier',
      'balanced',
      '--apply',
    ]);
    expect(tts.code).toBe(0);
    const flash = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'elevenlabs/eleven-flash-v2.5' },
      include: { prices: true },
    });
    expect(flash.prices.map((p) => [p.metric, p.unitPrice.toString()])).toEqual([
      ['input_characters', '0.00004'],
    ]);
    expect(flash.mediaConstraints).toMatchObject({ kind: 'tts', mp3: true });
  });
});

describe('smoke-video / smoke-tts (paid, capped)', () => {
  it('is refused unless enabled, without a key, or above the cap', async () => {
    const args = [
      'smoke-video',
      'google/veo-3.1-lite',
      '--project',
      projectSlug,
      '--max-cost-usd',
      '1',
    ];
    expect((await cli(args, { ...apiEnv, OPENROUTER_API_KEY: KEY })).err).toContain(
      'ACF_PAID_SMOKE=1',
    );
    expect((await cli(args, { ...apiEnv, ACF_PAID_SMOKE: '1' })).err).toContain('no credentials');
    const capped = await cli(
      ['smoke-video', 'google/veo-3.1-lite', '--project', projectSlug, '--max-cost-usd', '0.1'],
      { ...apiEnv, ACF_PAID_SMOKE: '1', OPENROUTER_API_KEY: KEY },
    );
    expect(capped.code).toBe(2);
    expect(capped.err).toMatch(/worst case 0\.24 USD exceeds/); // 4 s × 0.03 × safety factor 2
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('submits once, polls, downloads, validates and records the reported cost', async () => {
    const out = path.join(dir, 'videos');
    const result = await cli(
      [
        'smoke-video',
        'google/veo-3.1-lite',
        '--project',
        projectSlug,
        '--max-cost-usd',
        '1',
        '--duration',
        '4',
        '--out',
        out,
      ],
      { ...apiEnv, ACF_PAID_SMOKE: '1', OPENROUTER_API_KEY: KEY, ACF_SMOKE_POLL_MS: '5' },
    );
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('360×640 h264');
    expect(result.out).toContain('reported 0.18');
    expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/v1/videos')).toHaveLength(
      1,
    );
    expect(requests.find((r) => r.url === '/api/v1/videos')?.body).toMatchObject({
      model: 'google/veo-3.1-lite',
      duration: 4,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
      provider: { data_collection: 'deny' },
    });
    expect(await readdir(out)).toEqual(['google_veo-3.1-lite-1.mp4']);
    const inv = await prisma.aiInvocation.findFirstOrThrow({ where: { providerRequestId: JOB } });
    expect([
      inv.capability,
      inv.status,
      inv.costStatus,
      inv.reportedCost?.toString(),
      inv.estimatedCost?.toString(),
    ]).toEqual(['video_generation', 'succeeded', 'reported', '0.18', '0.12']);
  });

  it('synthesizes speech with ZDR and records the generation cost', async () => {
    const out = path.join(dir, 'tts');
    const result = await cli(
      [
        'smoke-tts',
        'elevenlabs/eleven-flash-v2.5',
        '--voice',
        'sarah',
        '--project',
        projectSlug,
        '--max-cost-usd',
        '0.05',
        '--out',
        out,
      ],
      { ...apiEnv, ACF_PAID_SMOKE: '1', OPENROUTER_API_KEY: KEY },
    );
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(requests.find((r) => r.url === '/api/v1/audio/speech')?.body).toMatchObject({
      voice: 'sarah',
      response_format: 'mp3',
      provider: { data_collection: 'deny', zdr: true },
    });
    const inv = await prisma.aiInvocation.findFirstOrThrow({
      where: { providerRequestId: 'gen-tts-1' },
    });
    expect([inv.capability, inv.status, inv.reportedCost?.toString()]).toEqual([
      'tts',
      'succeeded',
      '0.0042',
    ]);
    expect((await readdir(out)).length).toBe(1);

    const unknownVoice = await cli(
      [
        'smoke-tts',
        'elevenlabs/eleven-flash-v2.5',
        '--voice',
        'nobody',
        '--project',
        projectSlug,
        '--max-cost-usd',
        '0.05',
      ],
      { ...apiEnv, ACF_PAID_SMOKE: '1', OPENROUTER_API_KEY: KEY },
    );
    expect(unknownVoice.err).toContain('voice nobody is not offered by the model');
  });
});
