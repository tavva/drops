// ABOUTME: Packages safe local file and directory sources into temporary ZIP archives for deployment.
// ABOUTME: Rejects symlinks and early limit violations while registering idempotent lifecycle cleanup.
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import { DropsCliError } from './errors.js';
import type { LifecycleRegistrar } from './lifecycle.js';

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
  registerCleanup?: LifecycleRegistrar;
  onCleanupWarning?: (message: string) => void;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
  createTemporaryDirectory?: () => Promise<string>;
  beforeOpenSources?: (files: readonly SourceFile[]) => Promise<void>;
  createSourceStream?: (handle: FileHandle, file: SourceFile) => Readable;
  createOutputStream?: (path: string) => Writable;
  writeArchive?: (files: readonly OpenSource[], path: string, signal?: AbortSignal) => Promise<void>;
}

function sourceError(code: string, message: string, path: string): DropsCliError {
  return new DropsCliError({ code, message, details: { path }, exitCode: 2 });
}

function ignored(path: string): boolean {
  const segments = path.split('/');
  return IGNORED_BASENAMES.has(segments.at(-1) ?? '') || segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

export interface SourceFile {
  diskPath: string;
  archivePath: string;
  byteSize: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface OpenSource {
  file: SourceFile;
  handle: FileHandle;
  stream: Readable;
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
        files.push({
          diskPath,
          archivePath,
          byteSize: metadata.size,
          dev: metadata.dev,
          ino: metadata.ino,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs,
        });
      } else {
        throw sourceError('source_unsupported', `Unsupported source entry: ${diskPath}`, diskPath);
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0);
}

function sameIdentity(file: SourceFile, metadata: Awaited<ReturnType<FileHandle['stat']>>): boolean {
  return metadata.isFile()
    && metadata.dev === file.dev
    && metadata.ino === file.ino
    && metadata.size === file.byteSize
    && metadata.mtimeMs === file.mtimeMs
    && metadata.ctimeMs === file.ctimeMs;
}

function changed(path: string): DropsCliError {
  return sourceError('source_changed', `Source changed while it was being packaged: ${path}`, path);
}

async function openSources(files: readonly SourceFile[], options: PackageSourceOptions): Promise<OpenSource[]> {
  const opened: OpenSource[] = [];
  try {
    for (const file of files) {
      let handle: FileHandle;
      try {
        handle = await open(file.diskPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        throw changed(file.diskPath);
      }
      try {
        const metadata = await handle.stat();
        if (!sameIdentity(file, metadata)) throw changed(file.diskPath);
        const stream = options.createSourceStream?.(handle, file)
          ?? (file.byteSize === 0
            ? Readable.from([])
            : handle.createReadStream({ autoClose: false, start: 0, end: file.byteSize - 1 }));
        opened.push({ file, handle, stream });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return opened;
  } catch (error) {
    await Promise.allSettled(opened.map(async ({ stream, handle }) => {
      stream.destroy();
      await handle.close();
    }));
    throw error;
  }
}

async function writeArchive(
  files: readonly OpenSource[],
  archivePath: string,
  signal?: AbortSignal,
  createOutputStream: (path: string) => Writable = (path) => createWriteStream(path, { flags: 'wx' }),
): Promise<void> {
  const zip = new ZipFile();
  const zipOutput = zip.outputStream as Readable;
  const output = createOutputStream(archivePath);
  for (const source of files) {
    source.stream.once('error', (error) => zipOutput.destroy(error));
    zip.addReadStream(source.stream, source.file.archivePath, {
      size: source.file.byteSize,
      mtime: ZIP_MTIME,
      mode: 0o100644,
    });
  }
  zip.end();
  await pipeline(zipOutput, output, { signal });
}

async function generateArchive(files: SourceFile[], options: PackageSourceOptions): Promise<PackagedSource> {
  const temporaryDirectory = await (options.createTemporaryDirectory?.() ?? mkdtemp(join(tmpdir(), 'drops-cli-')));
  const archivePath = join(temporaryDirectory, 'upload.zip');
  const removeTemporaryDirectory = options.removeTemporaryDirectory ?? ((path: string) => rm(path, { recursive: true, force: true }));
  let cleanupPromise: Promise<void> | undefined;
  let unregister = () => {};
  const abortListener = () => void cleanup();
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      unregister();
      options.signal?.removeEventListener('abort', abortListener);
      await removeTemporaryDirectory(temporaryDirectory);
    })();
    return cleanupPromise;
  };
  unregister = options.registerCleanup?.(cleanup) ?? unregister;
  options.signal?.addEventListener('abort', abortListener, { once: true });

  let opened: OpenSource[] = [];
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Packaging aborted');
    await options.beforeOpenSources?.(files);
    opened = await openSources(files, options);
    try {
      if (options.writeArchive !== undefined) {
        await options.writeArchive(opened, archivePath, options.signal);
      } else {
        await writeArchive(opened, archivePath, options.signal, options.createOutputStream);
      }
      for (const source of opened) {
        if (!sameIdentity(source.file, await source.handle.stat())) throw changed(source.file.diskPath);
      }
    } finally {
      await Promise.allSettled(opened.map(async ({ stream, handle }) => {
        stream.destroy();
        await handle.close();
      }));
      opened = [];
    }
    const metadata = await lstat(archivePath);
    if (metadata.size > MAX_TOTAL_BYTES) {
      throw sourceError('total_size', 'Generated ZIP exceeds the 100 MB compressed limit', archivePath);
    }
    return { path: archivePath, byteSize: metadata.size, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      try {
        options.onCleanupWarning?.('Could not remove the temporary deployment archive');
      } catch {
        // Preserve the primary packaging error when diagnostic output is unavailable.
      }
    }
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
    return generateArchive([{
      diskPath: path,
      archivePath: basename(path),
      byteSize: metadata.size,
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    }], options);
  }
  if (metadata.isDirectory()) return generateArchive(await collectDirectory(path), options);
  throw sourceError('source_unsupported', `Unsupported source: ${path}`, path);
}
