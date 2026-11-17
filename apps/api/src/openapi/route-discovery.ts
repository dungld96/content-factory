import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { PUBLIC_METADATA, type PublicRule } from '../auth/public.decorator.js';
import { ENDPOINT_METADATA, type EndpointSpec } from '../common/http/endpoint.js';

export interface RouteInfo {
  /** Lower-case HTTP method, e.g. `get`. */
  readonly method: string;
  /** Path below the global prefix, Nest syntax (`/projects/:projectId`). */
  readonly path: string;
  readonly handler: string;
  readonly spec: EndpointSpec | undefined;
  /** `@Public()` rule on the handler or its controller (undefined: session required). */
  readonly publicRule: PublicRule | undefined;
}

const toArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [''];

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((p) => p.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${joined}`;
}

/** Every route registered by every controller, with its `@Endpoint` metadata (if any). */
export function discoverRoutes(discovery: DiscoveryService, scanner: MetadataScanner): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance: unknown = wrapper.instance;
    const metatype = wrapper.metatype;
    if (typeof instance !== 'object' || instance === null || !metatype) continue;
    const prototype = Object.getPrototypeOf(instance) as object;
    const basePaths = toArray(Reflect.getMetadata(PATH_METADATA, metatype));
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const methodPaths = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
      if (methodPaths === undefined || typeof requestMethod !== 'number') continue;
      const method = (RequestMethod[requestMethod] ?? 'GET').toLowerCase();
      const spec = Reflect.getMetadata(ENDPOINT_METADATA, handler) as EndpointSpec | undefined;
      const publicRule = (Reflect.getMetadata(PUBLIC_METADATA, handler) ??
        Reflect.getMetadata(PUBLIC_METADATA, metatype)) as PublicRule | undefined;
      for (const base of basePaths) {
        for (const sub of toArray(methodPaths)) {
          routes.push({
            method,
            path: joinPath(base, sub),
            handler: `${metatype.name}.${name}`,
            spec,
            publicRule,
          });
        }
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
