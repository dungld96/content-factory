import { Controller, Get, HttpCode, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import {
  csrfResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  preferencesRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type PreferencesRequest,
} from '@acf/contracts';

import { Endpoint, ValidBody } from '../common/http/endpoint.js';
import { CurrentActor, type Actor } from './actor.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @UseGuards(ThrottlerGuard)
  @Endpoint({
    summary: 'Sign in; sets the session cookie and returns a CSRF token',
    tags: ['auth'],
    body: loginRequestSchema,
    responses: { 200: { description: 'Signed in', schema: loginResponseSchema } },
    errors: [400, 401, 403, 429],
  })
  login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @ValidBody() body: LoginRequest,
  ): Promise<LoginResponse> {
    return this.auth.login(req, res, body);
  }

  @Post('logout')
  @HttpCode(204)
  @Endpoint({
    summary: 'Sign out; revokes the session immediately',
    tags: ['auth'],
    headers: ['x-csrf-token'],
    responses: { 204: { description: 'Signed out' } },
    errors: [401, 403],
  })
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.auth.logout(req, res);
  }

  @Get('me')
  @Endpoint({
    summary: 'The signed-in user and their project memberships',
    tags: ['auth'],
    responses: { 200: { description: 'Profile', schema: meResponseSchema } },
    errors: [401],
  })
  me(@CurrentActor() actor: Actor): Promise<MeResponse> {
    return this.auth.me(actor);
  }

  @Patch('me/preferences')
  @Endpoint({
    summary: "Change the signed-in user's own preferences (interface language)",
    tags: ['auth'],
    headers: ['x-csrf-token'],
    body: preferencesRequestSchema,
    responses: { 200: { description: 'Updated profile', schema: meResponseSchema } },
    errors: [400, 401, 403],
  })
  updatePreferences(
    @CurrentActor() actor: Actor,
    @ValidBody() body: PreferencesRequest,
  ): Promise<MeResponse> {
    return this.auth.updatePreferences(actor, body);
  }

  @Get('csrf')
  @Endpoint({
    summary: 'A fresh CSRF token for the current session',
    tags: ['auth'],
    responses: { 200: { description: 'Token', schema: csrfResponseSchema } },
    errors: [401],
  })
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response): { csrfToken: string } {
    return this.auth.csrfToken(req, res);
  }
}
