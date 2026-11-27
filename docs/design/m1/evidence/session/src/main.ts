import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Body, Controller, Get, HttpCode, Module, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import type { Request, Response } from 'express';
import session from 'express-session';

import { PrismaClient } from './generated/prisma/client.js';
import { PrismaSessionStore, type SessionStoreEvent } from './prisma-session-store.js';

const SECURE = process.env['SECURE'] === 'true';
const COOKIE = SECURE ? '__Host-acf_sid' : 'acf_sid';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] ?? '' }) });
const events: SessionStoreEvent[] = [];
const store = new PrismaSessionStore(prisma, {
  absoluteTtlMs: 7 * 86_400_000,
  idleTtlMs: Number(process.env['IDLE_MS'] ?? 86_400_000),
  touchThrottleMs: Number(process.env['TOUCH_THROTTLE_MS'] ?? 0),
  onEvent: (e) => events.push(e),
});

const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
  getSecret: () => 'spike-csrf-secret-at-least-32-characters!!',
  getSessionIdentifier: (req) => req.sessionID,
  cookieName: SECURE ? '__Host-acf_csrf' : 'acf_csrf',
  cookieOptions: { sameSite: 'lax', secure: SECURE, path: '/', httpOnly: true },
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

const p = (fn: (cb: (e?: unknown) => void) => void) => new Promise<void>((ok, fail) => fn((e) => (e ? fail(e) : ok())));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Controller('api/v1')
class SpikeController {
  @Post('auth/login') @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { email: string }) {
    const user = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (!user) throw new UnauthorizedException();
    await p((cb) => req.session.regenerate(cb)); // fixation defence: old row deleted, fresh ID
    req.session.userId = user.id;
    req.session.authenticatedAt = new Date().toISOString();
    await store.createForLogin(req.sessionID, req.session); // the only INSERT path
    if (SECURE && !req.secure) throw new Error('SESSION_COOKIE_NOT_SET'); // fail closed (design §5.5)
    return { userId: user.id, csrfToken: generateCsrfToken(req, res) };
  }

  @Get('auth/me')
  async me(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    const row = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { status: true } });
    if (row?.status !== 'active') throw new UnauthorizedException();
    return { userId: req.session.userId, authenticatedAt: req.session.authenticatedAt };
  }

  @Get('auth/slow')
  async slow(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    await pause(1500);
    return { userId: req.session.userId };
  }

  /** Request A: modifies a PERSISTED field, then pauses before the response (and store.set) completes. */
  @Post('auth/slow-modify') @HttpCode(200)
  async slowModify(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    req.session.authenticatedAt = new Date().toISOString();
    await pause(1500);
    return { ok: true };
  }

  /** Same, but modifies a NON-persisted field (still triggers store.set). */
  @Post('auth/slow-modify-scratch') @HttpCode(200)
  async slowModifyScratch(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    req.session.scratch = String(Date.now());
    await pause(1500);
    return { ok: true };
  }

  /** Fast modification without logout: legitimate updates must still persist. */
  @Post('auth/reauth') @HttpCode(200)
  reauth(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    req.session.authenticatedAt = new Date(Date.now() + 1000).toISOString();
    return { authenticatedAt: req.session.authenticatedAt };
  }

  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await p((cb) => req.session.destroy(cb));
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: SECURE });
  }

  @Post('mutate') @HttpCode(200)
  mutate(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    return { ok: true };
  }

  // ---- spike-only test hooks (not part of the M1 API) ----
  @Post('debug/revoke-user') @HttpCode(200)
  async revokeUser(@Body() body: { email: string }) {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: body.email }, select: { id: true } });
    return { revoked: await store.destroyAllForUser(u.id) };
  }
  /** Anonymous request that writes to its session: must not create a row or a cookie. */
  @Post('debug/anon-write') @HttpCode(200)
  anonWrite(@Req() req: Request) { req.session.scratch = 'x'; return { ok: true }; }
  @Get('debug/store-events') events() { return events; }
  @Post('debug/store-events/reset') @HttpCode(204) resetEvents() { events.length = 0; }
  @Get('debug/request')
  dbg(@Req() req: Request) {
    return { secure: req.secure, protocol: req.protocol, xfp: req.headers['x-forwarded-proto'] ?? null, xfh: req.headers['x-forwarded-host'] ?? null };
  }
}

@Module({ controllers: [SpikeController] })
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
app.set('trust proxy', 'loopback');
app.use(cookieParser());
app.use(session({
  name: COOKIE, secret: ['spike-session-secret-current-32chars!!', 'spike-session-secret-previous-32chars!'],
  store, resave: false, saveUninitialized: false, rolling: true, unset: 'destroy',
  cookie: { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/', maxAge: Number(process.env['IDLE_MS'] ?? 86_400_000) },
}));
app.use('/api/v1/mutate', doubleCsrfProtection);
await app.listen(Number(process.env['PORT'] ?? 4100), '127.0.0.1');
const nestRequire = createRequire(import.meta.resolve('@nestjs/platform-express'));
const own = createRequire(import.meta.url);
console.log(JSON.stringify({ msg: 'spike api listening', SECURE, COOKIE,
  expressUsedByNest: (nestRequire('express/package.json') as { version: string }).version,
  expressSession: (own('express-session/package.json') as { version: string }).version,
  prisma: (own('@prisma/client/package.json') as { version: string }).version,
  adapterPg: (JSON.parse(readFileSync(new URL('../node_modules/@prisma/adapter-pg/package.json', import.meta.url), 'utf8')) as { version: string }).version }));
