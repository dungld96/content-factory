import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

import { etagFor } from './etag.js';

/**
 * Adds `ETag: W/"<updatedAt epoch-ms>"` to single-resource responses (an object body with an
 * ISO `updatedAt` and no `data` list), so controllers never handle headers (design §8.4).
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        if (
          ctx.getType() === 'http' &&
          typeof body === 'object' &&
          body !== null &&
          !('data' in body)
        ) {
          const updatedAt = (body as { updatedAt?: unknown }).updatedAt;
          if (typeof updatedAt === 'string') {
            const date = new Date(updatedAt);
            if (!Number.isNaN(date.getTime())) {
              ctx.switchToHttp().getResponse<Response>().setHeader('ETag', etagFor(date));
            }
          }
        }
        return body;
      }),
    );
  }
}
