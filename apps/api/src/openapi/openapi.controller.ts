import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../auth/public.decorator.js';
import { Endpoint } from '../common/http/endpoint.js';
import { OpenApiService } from './openapi.service.js';

@Controller()
export class OpenApiController {
  constructor(private readonly openApi: OpenApiService) {}

  @Get('openapi.json')
  // Public outside production by default; otherwise only for signed-in users.
  @Public((env) => env.OPENAPI_PUBLIC)
  @Endpoint({
    summary: 'OpenAPI 3.1 document of this API',
    tags: ['meta'],
    responses: {
      200: { description: 'The OpenAPI document', schema: z.record(z.string(), z.unknown()) },
    },
    errors: [401],
  })
  document(): unknown {
    return this.openApi.document();
  }
}
