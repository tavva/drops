// ABOUTME: Upload limits, types, and streaming writers for folder-style multipart uploads.
// ABOUTME: Errors cause the partially-written R2 prefix to be removed before the exception propagates.
import { PassThrough, Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { CopyObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { s3, deletePrefix } from '@/lib/r2';
import { config } from '@/config';
import { mimeFor } from '@/lib/mime';
import { sanitisePath } from '@/lib/path';
import { UploadError } from './uploadErrors';

export const UPLOAD_LIMITS = {
  totalBytes: 100 * 1024 * 1024,
  fileCount: 1000,
  perFileBytes: 25 * 1024 * 1024,
  bombRatio: 100,
  bombMinAbsoluteBytes: 10 * 1024 * 1024,
} as const;

export interface UploadedFile {
  path: string;
  bytes: number;
}

export interface UploadResult {
  files: UploadedFile[];
  totalBytes: number;
  fileCount: number;
}

export interface MultipartPart {
  fieldName: string;
  filename: string;
  file: Readable;
  fields: Record<string, string>;
}

export async function uploadFolderParts(
  r2Prefix: string,
  parts: AsyncIterable<MultipartPart>,
): Promise<UploadResult> {
  const seen = new Set<string>();
  const files: UploadedFile[] = [];
  let totalBytes = 0;

  try {
    for await (const part of parts) {
      if (files.length + 1 > UPLOAD_LIMITS.fileCount) {
        throw new UploadError('file_count');
      }
      const res = sanitisePath(part.filename);
      if (!res.ok) throw new UploadError('path_rejected', `path rejected (${res.reason}): ${part.filename}`);
      const key = res.path;
      if (seen.has(key)) throw new UploadError('path_collision', `duplicate path: ${key}`);
      seen.add(key);

      const counter = new PassThrough();
      let fileBytes = 0;
      let aborted: UploadError | null = null;
      part.file.on('data', (chunk: Buffer) => {
        fileBytes += chunk.length;
        totalBytes += chunk.length;
        if (fileBytes > UPLOAD_LIMITS.perFileBytes) {
          aborted = new UploadError('per_file_size', `file exceeds ${UPLOAD_LIMITS.perFileBytes} bytes`);
          part.file.destroy();
        } else if (totalBytes > UPLOAD_LIMITS.totalBytes) {
          aborted = new UploadError('total_size', `upload exceeds ${UPLOAD_LIMITS.totalBytes} bytes`);
          part.file.destroy();
        }
      });
      part.file.pipe(counter);
      try {
        await new Upload({
          client: s3,
          params: {
            Bucket: config.R2_BUCKET,
            Key: r2Prefix + key,
            Body: counter,
            ContentType: mimeFor(key),
          },
          queueSize: 1,
        }).done();
      } catch (e) {
        if (aborted) throw aborted;
        throw e;
      }
      if (aborted) throw aborted;
      files.push({ path: key, bytes: fileBytes });
    }

    if (files.length === 0) throw new UploadError('path_rejected', 'no files uploaded');
    return { files, totalBytes, fileCount: files.length };
  } catch (e) {
    await safeDelete(r2Prefix);
    throw e;
  }
}

async function safeDelete(prefix: string) {
  try { await deletePrefix(prefix); } catch { /* swallow — cleanup is best-effort */ }
}

function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encodedKey}`;
}

export async function promoteSingleHtmlToIndex(
  r2Prefix: string,
  result: UploadResult,
): Promise<UploadResult> {
  if (result.files.some((f) => f.path === 'index.html')) return result;
  const htmls = result.files.filter((f) => f.path.toLowerCase().endsWith('.html'));
  if (htmls.length !== 1) return result;
  const single = htmls[0]!;
  if (single.path.includes('/')) return result;

  const sourceKey = r2Prefix + single.path;
  const targetKey = r2Prefix + 'index.html';
  await s3.send(new CopyObjectCommand({
    Bucket: config.R2_BUCKET,
    CopySource: encodeCopySource(config.R2_BUCKET, sourceKey),
    Key: targetKey,
  }));
  await s3.send(new DeleteObjectsCommand({
    Bucket: config.R2_BUCKET,
    Delete: { Objects: [{ Key: sourceKey }] },
  }));

  const files = result.files.map((f) =>
    f === single ? { path: 'index.html', bytes: f.bytes } : f,
  );
  return { ...result, files };
}
