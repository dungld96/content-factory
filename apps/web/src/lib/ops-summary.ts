import 'server-only';

import { cache } from 'react';

import type { OpsSummaryDto } from '@acf/contracts';

import { apiGet } from './api-server';

/** The operations summary, read once per request (sidebar counts, To-do, Operations). */
export const loadOpsSummary = cache(() => apiGet<OpsSummaryDto>('/ops/summary'));
