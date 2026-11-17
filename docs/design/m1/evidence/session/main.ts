import 'reflect-metadata';

import { createRequire } from 'node:module';

import { Body, Controller, Get, HttpCode, Module, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import type { Request, Response } from 'express';
import session from 'express-session';
import pg from 'pg';

import { PgHashedSessionStore } from './store.js';

const SECURE = process.env['SECURE'] === 'true';
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const store = new PgHashedSessionStore(pool, Number(process.env['ABSOLUTE_MS'] ?? 7 * 86_400_000));
const COOKIE = SECURE ? '__Host-acf_sid' : 'acf_sid';

const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
  getSecret: () => 'spike-csrf-secret-at-least-32-characters!!',
  getSessionIdentifier: (req) => req.sessionID,
  cookieName: SECURE ? '__Host-acf_csrf' : 'acf_csrf',
  cookieOptions: { sameSite: 'lax', secure: SECURE, path: '/', httpOnly: true },
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

const regenerate = (req: Request) => new Promise<void>((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
const save = (req: Request) => new Promise<void>((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
const destroy = (req: Request) => new Promise<void>((ok, fail) => req.session.destroy((e) => (e ? fail(e) : ok())));

@Controller('api/v1')
class SpikeController {
  @Post('auth/login') @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { email: string }) {
    const r = await pool.query(`SELECT id FROM users WHERE email = $1`, [body.email]);
    if (!r.rows[0]) throw new UnauthorizedException();
    await regenerate(req); // fixation defence: always a fresh ID
    req.session.userId = r.rows[0].id as string;
    req.session.authenticatedAt = new Date().toISOString();
    await save(req);
    return { userId: req.session.userId, csrfToken: generateCsrfToken(req, res) };
  }

  @Get('auth/me')
  me(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    return { userId: req.session.userId };
  }

  @Get('auth/slow')
  async slow(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    await new Promise((r) => setTimeout(r, 1500));
    return { userId: req.session.userId };
  }

  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await destroy(req);
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: SECURE });
  }

  @Post('mutate') @HttpCode(200)
  mutate(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    return { ok: true };
  }

  @Get('debug/request')
  dbg(@Req() req: Request) {
    return { secure: req.secure, protocol: req.protocol, ip: req.ip, xfp: req.headers['x-forwarded-proto'] ?? null,
             xfh: req.headers['x-forwarded-host'] ?? null, xff: req.headers['x-forwarded-for'] ?? null, origin: req.headers.origin ?? null };
  }
}

@Module({ controllers: [SpikeController] })
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
app.set('trust proxy', 'loopback'); // only the local Next.js proxy hop is trusted
app.use(cookieParser());
app.use(session({
  name: COOKIE, secret: ['spike-session-secret-current-32chars!!', 'spike-session-secret-previous-32chars!'],
  store, resave: false, saveUninitialized: false, rolling: true, unset: 'destroy',
  cookie: { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/', maxAge: Number(process.env['IDLE_MS'] ?? 86_400_000) },
}));
app.use('/api/v1/mutate', doubleCsrfProtection);
await app.listen(Number(process.env['PORT'] ?? 4100), '127.0.0.1');
const nestRequire = createRequire(import.meta.resolve('@nestjs/platform-express'));
console.log('spike api listening', { SECURE, COOKIE, expressUsedByNest: (nestRequire('express/package.json') as { version: string }).version,
  expressSession: (createRequire(import.meta.url)('express-session/package.json') as { version: string }).version });
