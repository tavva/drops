// ABOUTME: Zip upload path: spool to tmp, enforce symlink/bomb/size guards, unwrap single-root folders.
// ABOUTME: Every exit path removes the spool file and, on failure, clears the partially-written R2 prefix.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { Entry, ZipFile } from 'yauzl';
import { Upload } from '@aws-sdk/lib-storage';
import { s3, deletePrefix } from '@/lib/r2';
import { config } from '@/config';
import { mimeFor } from '@/lib/mime';
import { sanitisePath } from '@/lib/path';
import { UPLOAD_LIMITS, UploadResult, UploadedFile } from './upload';
import { UploadError } from './uploadErrors';

interface PreparedEntry {
  entry: Entry;
  sanitisedPath: string;
}

async function spool(stream: Readable, limit: number): Promise<string> {
  const path = join(tmpdir(), `drops-${randomUUID()}.zip`);
  let received = 0;
  let aborted: UploadError | null = null;
  const counter = new PassThrough();
  counter.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > limit && !aborted) {
      aborted = new UploadError('zip_too_large');
      stream.destroy(aborted);
      counter.destroy(aborted);
    }
  });
  try {
    await pipeline(stream, counter, createWriteStream(path));
  } catch (e) {
    await unlink(path).catch(() => undefined);
    if (aborted) throw aborted;
    if (e instanceof UploadError) throw e;
    throw new UploadError('invalid_zip', (e as Error).message);
  }
  if (aborted) {
    await unlink(path).catch(() => undefined);
    throw aborted;
  }
  return path;
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true }, (err, zip) => {
      if (err || !zip) {
        reject(new UploadError('invalid_zip', err?.message ?? 'failed to open zip'));
        return;
      }
      resolve(zip);
    });
  });
}

function enumerateEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', (e) => reject(new UploadError('invalid_zip', e.message)));
    zip.readEntry();
  });
}

function openReadStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new UploadError('invalid_zip', err?.message ?? 'failed to open entry'));
        return;
      }
      resolve(stream);
    });
  });
}

function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function stripSingleRoot(prepared: PreparedEntry[]): PreparedEntry[] {
  if (prepared.length === 0) return prepared;
  const first = prepared[0]!.sanitisedPath.split('/')[0];
  if (!first) return prepared;
  const allShareRoot = prepared.every((p) => {
    const segs = p.sanitisedPath.split('/');
    return segs.length > 1 && segs[0] === first;
  });
  if (!allShareRoot) return prepared;
  return prepared.map((p) => ({ ...p, sanitisedPath: p.sanitisedPath.split('/').slice(1).join('/') }));
}

export async function uploadZip(r2Prefix: string, stream: Readable): Promise<UploadResult> {
  const spoolPath = await spool(stream, UPLOAD_LIMITS.totalBytes);
  let zip: ZipFile | undefined;
  try {
    zip = await openZip(spoolPath);
    const all = await enumerateEntries(zip);
    const prepared: PreparedEntry[] = [];
    for (const entry of all) {
      if (entry.fileName.endsWith('/')) continue;
      if (isSymlink(entry)) throw new UploadError('zip_symlink');
      const res = sanitisePath(entry.fileName);
      if (!res.ok) throw new UploadError('path_rejected', `path rejected (${res.reason}): ${entry.fileName}`);
      prepared.push({ entry, sanitisedPath: res.path });
    }
    const unwrapped = stripSingleRoot(prepared);
    const seen = new Set<string>();
    let declaredTotal = 0;
    for (const p of unwrapped) {
      if (seen.has(p.sanitisedPath)) throw new UploadError('path_collision', `duplicate path: ${p.sanitisedPath}`);
      seen.add(p.sanitisedPath);
      const uncompressed = Number(p.entry.uncompressedSize);
      const compressed = Number(p.entry.compressedSize);
      if (uncompressed > UPLOAD_LIMITS.perFileBytes) throw new UploadError('per_file_size');
      if (
        uncompressed > UPLOAD_LIMITS.bombMinAbsoluteBytes &&
        compressed > 0 &&
        compressed * UPLOAD_LIMITS.bombRatio < uncompressed
      ) {
        throw new UploadError('zip_bomb');
      }
      declaredTotal += uncompressed;
      if (declaredTotal > UPLOAD_LIMITS.totalBytes) throw new UploadError('total_size');
    }
    if (unwrapped.length > UPLOAD_LIMITS.fileCount) throw new UploadError('file_count');
    if (unwrapped.length === 0) throw new UploadError('path_rejected', 'zip contained no files');

    const files: UploadedFile[] = [];
    let totalBytes = 0;
    const zipRef = zip;
    for (const p of unwrapped) {
      const src = await openReadStream(zipRef, p.entry);
      const counter = new PassThrough();
      let entryBytes = 0;
      let aborted: UploadError | null = null;
      src.on('data', (chunk: Buffer) => {
        entryBytes += chunk.length;
        totalBytes += chunk.length;
        if (entryBytes > UPLOAD_LIMITS.perFileBytes) {
          aborted = new UploadError('per_file_size');
          src.destroy();
        } else if (totalBytes > UPLOAD_LIMITS.totalBytes) {
          aborted = new UploadError('total_size');
          src.destroy();
        } else if (
          entryBytes > UPLOAD_LIMITS.bombMinAbsoluteBytes &&
          Number(p.entry.compressedSize) * UPLOAD_LIMITS.bombRatio < entryBytes
        ) {
          aborted = new UploadError('zip_bomb');
          src.destroy();
        }
      });
      src.pipe(counter);
      try {
        await new Upload({
          client: s3,
          params: {
            Bucket: config.R2_BUCKET,
            Key: r2Prefix + p.sanitisedPath,
            Body: counter,
            ContentType: mimeFor(p.sanitisedPath),
          },
          queueSize: 1,
        }).done();
      } catch (e) {
        if (aborted) throw aborted;
        throw e;
      }
      if (aborted) throw aborted;
      files.push({ path: p.sanitisedPath, bytes: entryBytes });
    }
    return { files, totalBytes, fileCount: files.length };
  } catch (e) {
    await safeDelete(r2Prefix);
    throw e;
  } finally {
    if (zip) zip.close();
    await unlink(spoolPath).catch(() => undefined);
  }
}

async function safeDelete(prefix: string) {
  try { await deletePrefix(prefix); } catch { /* cleanup best-effort */ }
}

export function createReadableFromFile(path: string) {
  return createReadStream(path);
}
