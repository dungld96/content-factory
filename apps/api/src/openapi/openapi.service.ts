import { STATUS_CODES } from 'node:http';

import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { z } from 'zod';
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponsesObject,
} from 'zod-openapi';

import { apiErrorResponseSchema } from '@acf/contracts';

import { API_PREFIX } from '../common/http/prefix.js';
import { discoverRoutes, type RouteInfo } from './route-discovery.js';

type OpenApiDocument = ReturnType<typeof createDocument>;

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function operationFor(route: RouteInfo): ZodOpenApiOperationObject {
  const spec = route.spec;
  if (!spec) throw new Error(`${route.handler} has no @Endpoint metadata`);
  const responses: ZodOpenApiResponsesObject = {};
  for (const [status, response] of Object.entries(spec.responses)) {
    responses[status as `${1 | 2 | 3 | 4 | 5}${string}`] = {
      description: response.description,
      ...(response.schema ? { content: { 'application/json': { schema: response.schema } } } : {}),
    };
  }
  for (const status of spec.errors ?? []) {
    responses[String(status) as `${4 | 5}${string}`] = {
      description: STATUS_CODES[status] ?? 'Error',
      content: { 'application/json': { schema: apiErrorResponseSchema } },
    };
  }
  const headerShape: Record<string, z.ZodType> = {};
  for (const header of spec.headers ?? []) headerShape[header] = z.string().optional();
  const hasHeaders = Object.keys(headerShape).length > 0;
  const hasParams = spec.params ?? spec.query ?? hasHeaders;
  return {
    summary: spec.summary,
    operationId: route.handler.replace('.', '_'),
    ...(spec.tags ? { tags: [...spec.tags] } : {}),
    ...(hasParams
      ? {
          requestParams: {
            ...(spec.params ? { path: spec.params } : {}),
            ...(spec.query ? { query: spec.query } : {}),
            ...(hasHeaders ? { header: z.object(headerShape) } : {}),
          },
        }
      : {}),
    ...(spec.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: spec.body } } } }
      : {}),
    responses,
  };
}

/** Builds the OpenAPI 3.1 document from every route's `@Endpoint` Zod schemas. */
@Injectable()
export class OpenApiService {
  private cached: OpenApiDocument | undefined;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  routes(): RouteInfo[] {
    return discoverRoutes(this.discovery, this.scanner);
  }

  document(): OpenApiDocument {
    if (this.cached) return this.cached;
    const paths: ZodOpenApiPathsObject = {};
    // Undocumented routes are skipped here; the route-coverage test fails on them.
    for (const route of this.routes().filter((r) => r.spec !== undefined)) {
      const key = toOpenApiPath(route.path) as `/${string}`;
      paths[key] = { ...paths[key], [route.method]: operationFor(route) };
    }
    this.cached = createDocument({
      openapi: '3.1.0',
      info: { title: 'AI Content Factory API', version: '0.1.0' },
      servers: [{ url: `/${API_PREFIX}` }],
      paths,
    });
    return this.cached;
  }
}
