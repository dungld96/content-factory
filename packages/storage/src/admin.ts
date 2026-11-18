import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/**
 * Storage administration (bucket setup only; M4a). Uses the storage admin key, which the API
 * and worker never receive.
 */
export interface StorageAdminSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Creates the bucket if it does not exist. Idempotent. Returns whether it was created. */
export async function ensureBucket(
  settings: StorageAdminSettings,
  bucket: string,
): Promise<boolean> {
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return false;
  } catch (error) {
    const code = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
    if (code !== 404) {
      client.destroy();
      throw error;
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return true;
  } finally {
    client.destroy();
  }
}

/** Admin settings from the environment (`S3_ENDPOINT`, `STORAGE_ADMIN_*`). */
export function storageAdminSettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): StorageAdminSettings {
  const need = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is not set (see .env.example)`);
    return value;
  };
  return {
    endpoint: need('S3_ENDPOINT'),
    region: env['S3_REGION']?.trim() || 'us-east-1',
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
    accessKeyId: need('STORAGE_ADMIN_ACCESS_KEY_ID'),
    secretAccessKey: need('STORAGE_ADMIN_SECRET_ACCESS_KEY'),
  };
}
