import 'server-only';

import { cache } from 'react';

import type { MeResponse } from '@acf/contracts';

import { apiGet } from './api-server';

/** `GET /auth/me`, once per request (layout, locale and pages share it). */
export const getMe = cache(() => apiGet<MeResponse>('/auth/me'));
