import {
  BadRequestException,
  HttpException,
  Logger,
  ServiceUnavailableException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error.js';
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

  it.each([
    [402, 'PAYMENT_REQUIRED'],
    [405, 'METHOD_NOT_ALLOWED'],
    [406, 'NOT_ACCEPTABLE'],
    [408, 'REQUEST_TIMEOUT'],
    [410, 'GONE'],
    [412, 'PRECONDITION_FAILED'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [428, 'PRECONDITION_REQUIRED'],
  ])('maps HTTP %i to %s', (statusCode, code) => {
    const { host, status, json } = hostFor();
    filter.catch(new HttpException('Rejected', statusCode), host);
    expect(status).toHaveBeenCalledWith(statusCode);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code, message: 'Rejected', retryable: false }) as unknown,
    });
  });

  it('uses a generic client code for unmapped 4xx statuses, not BAD_REQUEST', () => {
    const { host, status, json } = hostFor();
    filter.catch(new HttpException('Teapot', 418), host);
    expect(status).toHaveBeenCalledWith(418);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'CLIENT_ERROR' }) as unknown,
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

  it('passes validation details and an explicit retryable flag through', () => {
    const { host, status, json } = hostFor();
    filter.catch(
      new ApiError({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'The request is invalid.',
        details: [{ path: 'body.email', message: 'Invalid email' }],
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'body.email', message: 'Invalid email' }],
      }) as unknown,
    });

    const retry = hostFor();
    filter.catch(
      new ApiError({ status: 409, code: 'X', message: 'm', retryable: true }),
      retry.host,
    );
    expect(retry.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ retryable: true }) as unknown,
    });
  });

  it('maps database errors to their API codes without leaking driver messages', () => {
    const { host, status, json } = hostFor();
    filter.catch(
      { name: 'DriverAdapterError', cause: { originalCode: 'AC007', originalMessage: 'internal' } },
      host,
    );
    expect(status).toHaveBeenCalledWith(409);
    const payload = JSON.stringify(json.mock.calls[0]);
    expect(payload).toContain('LAST_OWNER');
    expect(payload).not.toContain('internal');
  });

  it('maps a deadlock to a retryable 409', () => {
    const { host, status, json } = hostFor();
    filter.catch({ name: 'DriverAdapterError', cause: { originalCode: '40P01' } }, host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'CONCURRENT_MODIFICATION',
        retryable: true,
      }) as unknown,
    });
  });
});
