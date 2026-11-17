import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

import type { ApiEnv } from '@acf/config';

import { Endpoint } from '../common/http/endpoint.js';
import { API_ENV } from '../config/api-config.module.js';
import { OpenApiService } from './openapi.service.js';

@Controller()
export class OpenApiController {
  constructor(
    private readonly openApi: OpenApiService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Get('openapi.json')
  @Endpoint({
    summary: 'OpenAPI 3.1 document of this API',
    tags: ['meta'],
    responses: {
      200: { description: 'The OpenAPI document', schema: z.record(z.string(), z.unknown()) },
    },
    errors: [404],
  })
  document(): unknown {
    // OPENAPI_PUBLIC=false hides the document (production default) until the auth guard (M1b-2)
    // can serve it to signed-in users.
    if (!this.env.OPENAPI_PUBLIC) throw new NotFoundException();
    return this.openApi.document();
  }
}
