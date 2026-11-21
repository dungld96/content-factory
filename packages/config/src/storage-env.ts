import { z } from 'zod';

import { booleanStringSchema, urlWithProtocol } from './schema-helpers.js';

const emptyAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Object storage (S3 API) for asset bytes (M4a, ADR-0006), shared by the API and the worker.
 * Optional as a group: when unset, storage-backed features answer `503 STORAGE_NOT_CONFIGURED`
 * instead of the process refusing to start. Credentials are server-only and never logged.
 */
export const storageEnvShape = {
  /** S3 endpoint, e.g. `http://127.0.0.1:8333` (SeaweedFS) or a provider's S3 URL. */
  S3_ENDPOINT: z.preprocess(
    emptyAsUndefined,
    urlWithProtocol(['https:', 'http:'], 'S3_ENDPOINT').optional(),
  ),
  S3_REGION: z.string().trim().min(1).default('us-east-1'),
  /** Private bucket for asset objects. */
  S3_BUCKET: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')
      .optional(),
  ),
  S3_ACCESS_KEY_ID: z.preprocess(emptyAsUndefined, z.string().trim().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  /** Path-style URLs (`endpoint/bucket/key`): required by SeaweedFS and most self-hosted servers. */
  S3_FORCE_PATH_STYLE: booleanStringSchema.default(true),
};

export type StorageEnv = z.output<z.ZodObject<typeof storageEnvShape>>;

const REQUIRED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

/** All four required variables or none. (Plain http is allowed: staging reaches storage on the internal Docker network.) */
export function checkStorageEnv(
  env: StorageEnv & { NODE_ENV: string },
  ctx: z.RefinementCtx,
): void {
  const set = REQUIRED.filter((key) => env[key] !== undefined);
  if (set.length > 0 && set.length < REQUIRED.length) {
    for (const key of REQUIRED) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when any S3_* storage variable is set',
        });
      }
    }
  }
}

export interface StorageSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** The storage settings, or `null` when storage is not configured. */
export function storageSettings(env: StorageEnv): StorageSettings | null {
  if (
    env.S3_ENDPOINT === undefined ||
    env.S3_BUCKET === undefined ||
    env.S3_ACCESS_KEY_ID === undefined ||
    env.S3_SECRET_ACCESS_KEY === undefined
  ) {
    return null;
  }
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
}
