import {
  createParamDecorator,
  HttpStatus,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import type { z } from 'zod';

import { ApiErrorCode, type ValidationIssue } from '@acf/contracts';

import { ApiError } from '../api-error.js';

/**
 * Single source of truth for a route's contract: the same Zod schemas validate the request
 * (via {@link ValidBody}/{@link ValidQuery}/{@link ValidParams}) and generate OpenAPI 3.1
 * (`OpenApiService`). A test asserts every registered route carries this metadata.
 */
export interface EndpointSpec {
  readonly summary: string;
  readonly tags?: readonly string[];
  readonly body?: z.ZodType;
  readonly query?: z.ZodObject;
  readonly params?: z.ZodObject;
  /** Success responses by status code; `schema` omitted for empty bodies (e.g. 204). */
  readonly responses: Readonly<
    Record<number, { readonly description: string; readonly schema?: z.ZodType }>
  >;
  /** Documented error statuses (the envelope schema is added automatically). */
  readonly errors?: readonly number[];
  /** Request headers the endpoint reads (documented only). */
  readonly headers?: readonly ('If-Match' | 'x-csrf-token' | 'Idempotency-Key')[];
}

export const ENDPOINT_METADATA = 'acf:endpoint';

export const Endpoint = (spec: EndpointSpec) => SetMetadata(ENDPOINT_METADATA, spec);

type Part = 'body' | 'query' | 'params';

function specOf(ctx: ExecutionContext): EndpointSpec {
  const spec = Reflect.getMetadata(ENDPOINT_METADATA, ctx.getHandler()) as EndpointSpec | undefined;
  if (!spec) {
    throw new Error(`${ctx.getClass().name}.${ctx.getHandler().name} has no @Endpoint metadata`);
  }
  return spec;
}

/** Converts Zod issues to `{ path, message }`, prefixed with the request part. */
export function toValidationIssues(part: Part, error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [part, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

export function validationError(details: readonly ValidationIssue[]): ApiError {
  return new ApiError({
    status: HttpStatus.BAD_REQUEST,
    code: ApiErrorCode.ValidationFailed,
    message: 'The request is invalid.',
    details,
  });
}

const PARTS: readonly Part[] = ['params', 'query', 'body'];

/** Parsed request parts per request, written by {@link RequestValidationInterceptor}. */
const parsedInput = new WeakMap<Request, Partial<Record<Part, unknown>>>();

/**
 * Validates every part the route declares in one pass, so a 400 lists all problems at once.
 * Runs after guards (authentication and CSRF come first) and before the handler.
 */
@Injectable()
export class RequestValidationInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = Reflect.getMetadata(ENDPOINT_METADATA, ctx.getHandler()) as
      EndpointSpec | undefined;
    if (spec && ctx.getType() === 'http') {
      const req = ctx.switchToHttp().getRequest<Request>();
      const parsed: Partial<Record<Part, unknown>> = {};
      const issues: ValidationIssue[] = [];
      for (const part of PARTS) {
        const schema = spec[part];
        if (!schema) continue;
        const result = schema.safeParse(req[part] ?? {});
        if (result.success) parsed[part] = result.data;
        else issues.push(...toValidationIssues(part, result.error));
      }
      if (issues.length > 0) throw validationError(issues);
      parsedInput.set(req, parsed);
    }
    return next.handle();
  }
}

function partDecorator(part: Part) {
  return createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
    if (!specOf(ctx)[part]) {
      throw new Error(`@Endpoint of ${ctx.getHandler().name} declares no ${part} schema`);
    }
    const parsed = parsedInput.get(ctx.switchToHttp().getRequest<Request>());
    if (!parsed || !(part in parsed)) {
      throw new Error('RequestValidationInterceptor is not registered');
    }
    return parsed[part];
  });
}

/** The request body, parsed with the route's `@Endpoint({ body })` schema. */
export const ValidBody = partDecorator('body');
/** The query string, parsed with the route's `@Endpoint({ query })` schema. */
export const ValidQuery = partDecorator('query');
/** The path parameters, parsed with the route's `@Endpoint({ params })` schema. */
export const ValidParams = partDecorator('params');
