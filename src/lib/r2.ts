// ABOUTME: Thin wrapper around the S3 SDK targeting either Cloudflare R2 (prod) or MinIO (dev/test).
// ABOUTME: Exposes put/get/head plus prefix list/delete helpers used by the upload and GC services.
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { config } from '@/config';

export function buildR2Endpoint(opts: { endpoint?: string; accountId: string }): string {
  if (opts.endpoint) return opts.endpoint;
  return `https://${opts.accountId}.r2.cloudflarestorage.com`;
}

export const s3 = new S3Client({
  region: 'auto',
  endpoint: buildR2Endpoint({ endpoint: config.R2_ENDPOINT, accountId: config.R2_ACCOUNT_ID }),
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: Boolean(config.R2_ENDPOINT),
});

export async function putObject(key: string, body: Buffer | Readable, contentType = 'application/octet-stream') {
  await new Upload({
    client: s3,
    params: { Bucket: config.R2_BUCKET, Key: key, Body: body, ContentType: contentType },
  }).done();
}

export interface GetResult {
  body: Readable;
  contentType: string;
  contentLength: number | undefined;
  etag: string | undefined;
}

export async function getObject(key: string): Promise<GetResult | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: config.R2_BUCKET, Key: key }));
    return {
      body: out.Body as Readable,
      contentType: out.ContentType ?? 'application/octet-stream',
      contentLength: out.ContentLength ?? undefined,
      etag: out.ETag ?? undefined,
    };
  } catch (e: unknown) {
    const name = (e as { name?: string; $metadata?: { httpStatusCode?: number } } | null);
    if (name?.name === 'NoSuchKey' || name?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function headObject(key: string) {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: config.R2_BUCKET, Key: key }));
    return {
      contentType: out.ContentType,
      contentLength: out.ContentLength,
      etag: out.ETag,
    };
  } catch (e: unknown) {
    const err = e as { $metadata?: { httpStatusCode?: number } };
    if (e instanceof NotFound || err?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function listPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: config.R2_BUCKET,
      Prefix: prefix,
      ContinuationToken,
    }));
    for (const c of out.Contents ?? []) if (c.Key) keys.push(c.Key);
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

export async function deletePrefix(prefix: string): Promise<void> {
  while (true) {
    const keys = (await listPrefix(prefix)).slice(0, 1000);
    if (keys.length === 0) return;
    await s3.send(new DeleteObjectsCommand({
      Bucket: config.R2_BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }));
  }
}
