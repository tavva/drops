// ABOUTME: Packages safe local file and directory sources into temporary ZIP archives for deployment.
// ABOUTME: Rejects symlinks and early limit violations while registering idempotent lifecycle cleanup.
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { finished } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import { DropsCliError } from './errors.js';

const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ZIP_MTIME = new Date('1980-01-01T00:00:00.000Z');
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.thumbnail']);
const IGNORED_SEGMENTS = new Set(['__MACOSX', '.AppleDouble']);

export interface PackagedSource {
  path: string;
  byteSize: number;
  cleanup(): Promise<void>;
}

export interface PackageSourceOptions {
  signal?: AbortSignal;
}

type Cleanup = () => Promise<void>;
const lifecycleCleanups = new Set<Cleanup>();

export function registerLifecycleCleanup(cleanup: Cleanup): () => void {
  lifecycleCleanups.add(cleanup);
  return () => lifecycleCleanups.delete(cleanup);
}

export async function runLifecycleCleanups(): Promise<void> {
  const cleanups = [...lifecycleCleanups];
  lifecycleCleanups.clear();
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
}

function sourceError(code: string, message: string, path: string): DropsCliError {
  return new DropsCliError({ code, message, details: { path }, exitCode: 2 });
}

function ignored(path: string): boolean {
  const segments = path.split('/');
  return IGNORED_BASENAMES.has(segments.at(-1) ?? '') || segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

interface SourceFile {
  diskPath: string;
  archivePath: string;
  byteSize: number;
}

async function sourceStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw sourceError('source_not_found', `Source does not exist: ${path}`, path);
    }
    throw sourceError('source_unreadable', `Could not inspect source: ${path}`, path);
  }
}

function checkFile(path: string, size: number, totals: { count: number; bytes: number }): void {
  if (size > MAX_FILE_BYTES) {
    throw sourceError('per_file_size', `File exceeds the 25 MB limit: ${path}`, path);
  }
  totals.count += 1;
  if (totals.count > MAX_FILE_COUNT) {
    throw sourceError('file_count', 'Source contains more than 1000 files', path);
  }
  totals.bytes += size;
  if (totals.bytes > MAX_TOTAL_BYTES) {
    throw sourceError('total_size', 'Source exceeds the 100 MB uncompressed limit', path);
  }
}

async function collectDirectory(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const totals = { count: 0, bytes: 0 };

  async function walk(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const diskPath = join(directory, name);
      const archivePath = relative(root, diskPath).split(sep).join('/');
      const metadata = await sourceStat(diskPath);
      if (metadata.isSymbolicLink()) {
        throw sourceError('source_symlink', `Symbolic links are not supported: ${diskPath}`, diskPath);
      }
      if (ignored(archivePath)) continue;
      if (metadata.isDirectory()) {
        await walk(diskPath);
      } else if (metadata.isFile()) {
        checkFile(diskPath, metadata.size, totals);
        files.push({ diskPath, archivePath, byteSize: metadata.size });
      } else {
        throw sourceError('source_unsupported', `Unsupported source entry: ${diskPath}`, diskPath);
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0);
}

async function generateArchive(files: SourceFile[], signal?: AbortSignal): Promise<PackagedSource> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'drops-cli-'));
  const archivePath = join(temporaryDirectory, 'upload.zip');
  let cleaned = false;
  let unregister = () => {};
  const abortListener = () => void cleanup();
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    unregister();
    signal?.removeEventListener('abort', abortListener);
    await rm(temporaryDirectory, { recursive: true, force: true });
  };
  unregister = registerLifecycleCleanup(cleanup);
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    if (signal?.aborted) throw signal.reason ?? new Error('Packaging aborted');
    const zip = new ZipFile();
    const output = createWriteStream(archivePath, { flags: 'wx' });
    zip.outputStream.pipe(output);
    for (const file of files) {
      zip.addFile(file.diskPath, file.archivePath, { mtime: ZIP_MTIME, mode: 0o100644 });
    }
    zip.end();
    await finished(output, { signal });
    const metadata = await lstat(archivePath);
    return { path: archivePath, byteSize: metadata.size, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function packageSource(path: string, options: PackageSourceOptions = {}): Promise<PackagedSource> {
  const metadata = await sourceStat(path);
  if (metadata.isSymbolicLink()) {
    throw sourceError('source_symlink', `Symbolic links are not supported: ${path}`, path);
  }
  if (metadata.isFile() && /\.zip$/iu.test(path)) {
    if (metadata.size > MAX_TOTAL_BYTES) {
      throw sourceError('total_size', 'ZIP exceeds the 100 MB compressed limit', path);
    }
    return { path, byteSize: metadata.size, cleanup: async () => {} };
  }
  if (metadata.isFile()) {
    const totals = { count: 0, bytes: 0 };
    checkFile(path, metadata.size, totals);
    return generateArchive([{ diskPath: path, archivePath: basename(path), byteSize: metadata.size }], options.signal);
  }
  if (metadata.isDirectory()) return generateArchive(await collectDirectory(path), options.signal);
  throw sourceError('source_unsupported', `Unsupported source: ${path}`, path);
}
