// ABOUTME: Packages safe local file and directory sources into temporary ZIP archives for deployment.
// ABOUTME: Rejects symlinks and early limit violations while registering idempotent lifecycle cleanup.
import { constants, createWriteStream, type Stats } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
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
  beforeTraverseDirectory?: (path: string, archivePath: string) => Promise<void>;
  createSourceStream?: (handle: FileHandle, file: SourceFile) => Readable;
  createOutputStream?: (path: string) => Writable;
  writeArchive?: (files: readonly SourceFile[], path: string, signal?: AbortSignal) => Promise<void>;
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
  directories: readonly SourceDirectory[];
}

export interface SourceDirectory {
  diskPath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
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

function directoryIdentity(path: string, metadata: Stats): SourceDirectory {
  return { diskPath: path, dev: metadata.dev, ino: metadata.ino, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
}

async function validateDirectory(directory: SourceDirectory, rootPath: string): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(directory.diskPath);
  } catch {
    throw changed(directory.diskPath);
  }
  if (metadata.isSymbolicLink()) {
    throw sourceError('source_symlink', `Symbolic links are not supported: ${directory.diskPath}`, directory.diskPath);
  }
  if (!metadata.isDirectory()
    || metadata.dev !== directory.dev
    || metadata.ino !== directory.ino
    || metadata.mtimeMs !== directory.mtimeMs
    || metadata.ctimeMs !== directory.ctimeMs) {
    throw changed(directory.diskPath);
  }
  const resolved = await realpath(directory.diskPath);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${sep}`)) throw changed(directory.diskPath);
}

async function validateDirectoryChain(chain: readonly SourceDirectory[], rootPath: string): Promise<void> {
  for (const directory of chain) await validateDirectory(directory, rootPath);
}

async function collectDirectory(
  root: string,
  rootMetadata: Stats,
  options: PackageSourceOptions,
): Promise<{ files: SourceFile[]; directories: SourceDirectory[]; rootPath: string }> {
  const files: SourceFile[] = [];
  const directories: SourceDirectory[] = [];
  const totals = { count: 0, bytes: 0 };
  const rootPath = await realpath(root);
  const rootDirectory = directoryIdentity(root, rootMetadata);

  async function walk(directory: SourceDirectory, chain: readonly SourceDirectory[]): Promise<void> {
    await validateDirectory(directory, rootPath);
    directories.push(directory);
    const names = (await readdir(directory.diskPath)).sort();
    await validateDirectory(directory, rootPath);
    for (const name of names) {
      const diskPath = join(directory.diskPath, name);
      const archivePath = relative(root, diskPath).split(sep).join('/');
      const metadata = await sourceStat(diskPath);
      if (metadata.isSymbolicLink()) {
        throw sourceError('source_symlink', `Symbolic links are not supported: ${diskPath}`, diskPath);
      }
      if (ignored(archivePath)) continue;
      if (metadata.isDirectory()) {
        const child = directoryIdentity(diskPath, metadata);
        await options.beforeTraverseDirectory?.(diskPath, archivePath);
        const childChain = [...chain, child];
        await validateDirectoryChain(childChain, rootPath);
        await walk(child, childChain);
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
          directories: chain,
        });
      } else {
        throw sourceError('source_unsupported', `Unsupported source entry: ${diskPath}`, diskPath);
      }
    }
  }

  await walk(rootDirectory, [rootDirectory]);
  return {
    files: files.sort((left, right) => left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0),
    directories,
    rootPath,
  };
}

function sameIdentity(file: SourceFile, metadata: Stats): boolean {
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

function openFailure(path: string, error: unknown): DropsCliError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return sourceError('source_unreadable', `Could not read source: ${path}`, path);
  if (code === 'EMFILE' || code === 'ENFILE') return sourceError('source_resource_limit', 'Too many source files are open', path);
  return changed(path);
}

async function writeArchive(
  files: readonly SourceFile[],
  directories: readonly SourceDirectory[],
  rootPath: string | undefined,
  archivePath: string,
  options: PackageSourceOptions,
): Promise<void> {
  const zip = new ZipFile();
  const zipOutput = zip.outputStream as Readable;
  const output = options.createOutputStream?.(archivePath) ?? createWriteStream(archivePath, { flags: 'wx' });
  const activeHandles = new Set<FileHandle>();
  zip.on('error', (error) => zipOutput.destroy(error));
  for (const file of files) {
    zip.addReadStreamLazy(file.archivePath, {
      size: file.byteSize,
      mtime: ZIP_MTIME,
      mode: 0o100644,
    }, (callback) => {
      void (async () => {
        if (rootPath !== undefined) {
          await validateDirectoryChain(file.directories, rootPath);
        }
        let handle: FileHandle;
        try {
          handle = await open(file.diskPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          throw openFailure(file.diskPath, error);
        }
        activeHandles.add(handle);
        try {
          if (!sameIdentity(file, await handle.stat())) throw changed(file.diskPath);
          const input = options.createSourceStream?.(handle, file)
            ?? (file.byteSize === 0
              ? Readable.from([])
              : handle.createReadStream({ autoClose: false, start: 0, end: file.byteSize - 1 }));
          const validator = new Transform({
            transform(chunk, _encoding, done) { done(null, chunk); },
            flush(done) {
              void handle.stat().then((metadata) => {
                if (!sameIdentity(file, metadata)) throw changed(file.diskPath);
              }).then(async () => {
                activeHandles.delete(handle);
                await handle.close();
                done();
              }, async (error) => {
                activeHandles.delete(handle);
                await handle.close().catch(() => {});
                done(error as Error);
              });
            },
          });
          validator.once('error', (error) => zip.emit('error', error));
          input.once('error', (error) => {
            zip.emit('error', error);
            validator.destroy();
          });
          input.pipe(validator);
          callback(null, validator);
        } catch (error) {
          activeHandles.delete(handle);
          await handle.close().catch(() => {});
          throw error;
        }
      })().catch((error) => callback(error, Readable.from([])));
    });
  }
  zip.end();
  try {
    await pipeline(zipOutput, output, { signal: options.signal });
    if (rootPath !== undefined) {
      await validateDirectoryChain(directories, rootPath);
    }
  } finally {
    await Promise.allSettled([...activeHandles].map((handle) => handle.close()));
  }
}

async function generateArchive(
  files: SourceFile[],
  options: PackageSourceOptions,
  directories: readonly SourceDirectory[] = [],
  rootPath?: string,
): Promise<PackagedSource> {
  const temporaryDirectory = await (options.createTemporaryDirectory?.() ?? mkdtemp(join(tmpdir(), 'drops-cli-')));
  const archivePath = join(temporaryDirectory, 'upload.zip');
  const removeTemporaryDirectory = options.removeTemporaryDirectory ?? ((path: string) => rm(path, { recursive: true, force: true }));
  let cleanupPromise: Promise<void> | undefined;
  let unregister = () => {};
  const warnCleanup = () => {
    try {
      options.onCleanupWarning?.('Could not remove the temporary deployment archive');
    } catch {
      // Cleanup diagnostics are best-effort.
    }
  };
  const abortListener = () => { void cleanup().catch(warnCleanup); };
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

  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Packaging aborted');
    await options.beforeOpenSources?.(files);
    if (options.writeArchive !== undefined) {
      await options.writeArchive(files, archivePath, options.signal);
    } else {
      await writeArchive(files, directories, rootPath, archivePath, options);
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
      warnCleanup();
    }
    throw error;
  }
}

async function snapshotZip(path: string, file: SourceFile, options: PackageSourceOptions): Promise<PackagedSource> {
  const temporaryDirectory = await (options.createTemporaryDirectory?.() ?? mkdtemp(join(tmpdir(), 'drops-cli-')));
  const snapshotPath = join(temporaryDirectory, 'upload.zip');
  const removeTemporaryDirectory = options.removeTemporaryDirectory ?? ((target: string) => rm(target, { recursive: true, force: true }));
  let cleanupPromise: Promise<void> | undefined;
  let unregister = () => {};
  const warnCleanup = () => {
    try {
      options.onCleanupWarning?.('Could not remove the temporary deployment archive');
    } catch {
      // Cleanup diagnostics are best-effort.
    }
  };
  const abortListener = () => { void cleanup().catch(warnCleanup); };
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

  let handle: FileHandle | undefined;
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Packaging aborted');
    await options.beforeOpenSources?.([file]);
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw openFailure(path, error);
    }
    if (!sameIdentity(file, await handle.stat())) throw changed(path);
    const input = file.byteSize === 0
      ? Readable.from([])
      : handle.createReadStream({ autoClose: false, start: 0, end: file.byteSize - 1 });
    const output = options.createOutputStream?.(snapshotPath) ?? createWriteStream(snapshotPath, { flags: 'wx' });
    await pipeline(input, output, { signal: options.signal });
    if (!sameIdentity(file, await handle.stat())) throw changed(path);
    await handle.close();
    handle = undefined;
    const snapshot = await lstat(snapshotPath);
    if (snapshot.size !== file.byteSize) throw changed(path);
    return { path: snapshotPath, byteSize: snapshot.size, cleanup };
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    try {
      await cleanup();
    } catch {
      warnCleanup();
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
    return snapshotZip(path, {
      diskPath: path,
      archivePath: basename(path),
      byteSize: metadata.size,
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      directories: [],
    }, options);
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
      directories: [],
    }], options);
  }
  if (metadata.isDirectory()) {
    const collected = await collectDirectory(path, metadata, options);
    return generateArchive(collected.files, options, collected.directories, collected.rootPath);
  }
  throw sourceError('source_unsupported', `Unsupported source: ${path}`, path);
}
