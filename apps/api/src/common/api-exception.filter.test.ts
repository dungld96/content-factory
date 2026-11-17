import {
  BadRequestException,
  HttpException,
  Logger,
  ServiceUnavailableException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiExceptionFilter } from './api-exception.filter.js';
import { correlationIdMiddleware } from './correlation-id.js';

function hostFor(correlationId = 'cid-123456') {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const req = { header: () => correlationId } as unknown as Request;
  const res = { status, setHeader: vi.fn() } as unknown as Response;
  correlationIdMiddleware(req, res, () => undefined);
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('ApiExceptionFilter', () => {
  const filter = new ApiExceptionFilter();

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('maps HttpExceptions to the error envelope', () => {
    const { host, status, json } = hostFor();
    filter.catch(new BadRequestException('Name is required'), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'BAD_REQUEST',
        message: 'Name is required',
        retryable: false,
        correlationId: 'cid-123456',
      },
    });
  });

  it('preserves explicit domain error codes', () => {
    const { host, json } = hostFor();
    filter.catch(
      new HttpException({ code: 'BUDGET_EXCEEDED', message: 'Budget exceeded' }, 402),
      host,
    );
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'BUDGET_EXCEEDED',
        message: 'Budget exceeded',
      }) as unknown,
    });
  });

  it('marks 503 as retryable', () => {
    const { host, json } = hostFor();
    filter.catch(new ServiceUnavailableException('Try later'), host);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ retryable: true }) as unknown,
    });
  });

  it('hides internal details of unknown errors', () => {
    const { host, status, json } = hostFor();
    filter.catch(new Error('password=hunter2 leaked in driver message'), host);
    expect(status).toHaveBeenCalledWith(500);
    const payload = JSON.stringify(json.mock.calls[0]);
    expect(payload).toContain('INTERNAL_ERROR');
    expect(payload).not.toContain('hunter2');
  });
});
