import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { storageSettings, type ApiEnv } from '@acf/config';
import { ApiErrorCode } from '@acf/contracts';
import { S3ObjectStore, StorageError, type ObjectStore } from '@acf/storage';

import { ApiError } from '../common/api-error.js';
import { API_ENV } from '../config/api-config.module.js';

/** Injection token for tests to replace the store (e.g. with `InMemoryObjectStore`). */
export const OBJECT_STORE_OVERRIDE = Symbol('OBJECT_STORE_OVERRIDE');

/**
 * Object storage for asset bytes (M4a, ADR-0006). `null` when the S3_* variables are unset:
 * storage-backed endpoints then answer `503 STORAGE_NOT_CONFIGURED`.
 */
@Injectable()
export class ObjectStoreService {
  readonly store: ObjectStore | null;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    const settings = storageSettings(env);
    this.store = settings ? new S3ObjectStore(settings) : null;
  }

  /** @throws {ApiError} 503 when storage is not configured. */
  require(): ObjectStore {
    if (!this.store) {
      throw new ApiError({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ApiErrorCode.StorageNotConfigured,
        message: 'Object storage is not configured on this server.',
        retryable: false,
      });
    }
    return this.store;
  }
}

/** Maps storage failures to API errors (never exposing endpoint or credential details). */
export function storageFailure(error: unknown): never {
  if (error instanceof StorageError && error.code === 'STORAGE_UNAVAILABLE') {
    throw new ApiError(
      {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ApiErrorCode.StorageUnavailable,
        message: 'Object storage is unavailable. Try again shortly.',
        retryable: true,
      },
      error,
    );
  }
  throw error;
}
