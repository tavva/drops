// ABOUTME: Downloads every file of a drop the caller can view into a local directory.
// ABOUTME: Validates paths locally and reveals the directory only once every file has arrived.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  DropsApiClient,
  type DropsReadFilesResult,
  type DropsUser,
  type ReadDropFileOptions,
} from './api.js';
import { authenticatedInstance, createCredentialStore, type CredentialDependencies } from './credentials.js';
import { DropsCliError } from './errors.js';
import { resolveInstance } from './instance.js';
import type { LifecycleRegistrar } from './lifecycle.js';
import { parseDropReference, type DropReference } from './reference.js';

export interface PullApi {
  whoami(origin: string, token: string): Promise<DropsUser>;
  readDropFiles(origin: string, token: string, owner: string, name: string): Promise<DropsReadFilesResult>;
  readDropFile(origin: string, token: string, options: ReadDropFileOptions): Promise<AsyncIterable<Uint8Array>>;
}

export interface PullDependencies extends CredentialDependencies {
  api: PullApi;
  registerCleanup?: LifecycleRegistrar;
}

export interface PullOptions {
  cwd: string;
  reference: string;
  directory?: string;
  instance?: string;
}

export interface PullResult {
  instance: string;
  owner: string;
  name: string;
  versionId: string | null;
  directory: string;
  fileCount: number;
  byteSize: number;
}

export function createPullDependencies(registerCleanup?: LifecycleRegistrar): PullDependencies {
  return { api: new DropsApiClient(), store: createCredentialStore(), resolveInstance, registerCleanup };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// A relative path whose every segment can name a drop entry, so it cannot escape the
// destination directory on disk.
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || CONTROL_CHARACTERS.test(path)) {
    return false;
  }
  // Drops never contain dot-prefixed entries, which also rules out `.` and `..`.
  return path.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));
}

async function resolveOwner(api: PullApi, origin: string, token: string, reference: DropReference): Promise<string> {
  return reference.owner ?? (await api.whoami(origin, token)).username;
}

function errnoCode(error: unknown): string | undefined {
  if (error instanceof DropsCliError) return undefined;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.startsWith('E') ? code : undefined;
}

function writeFailed(path: string, errno: string): DropsCliError {
  return new DropsCliError({
    code: 'write_failed',
    message: `Could not write ${path}: ${errno}`,
    details: { path, errno },
    exitCode: 6,
  });
}

async function assertEmptyOrMissing(directory: string): Promise<void> {
  let target;
  try {
    target = await stat(directory);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') return;
    if (code !== undefined) throw writeFailed(directory, code);
    throw error;
  }
  if (target.isDirectory() && (await readdir(directory)).length === 0) return;
  throw new DropsCliError({
    code: 'directory_not_empty',
    message: `${directory} exists and is not an empty directory`,
    details: { directory },
    guidance: { hint: 'Choose a new or empty destination directory.', examples: ['drops pull preview ./preview-copy'] },
    exitCode: 2,
  });
}

async function writeBody(body: AsyncIterable<Uint8Array>, target: string): Promise<number> {
  let size = 0;
  async function* counted() {
    for await (const chunk of body) {
      size += chunk.byteLength;
      yield chunk;
    }
  }
  await pipeline(counted(), createWriteStream(target, { flags: 'wx' }));
  return size;
}

async function localWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const code = errnoCode(error);
    throw code === undefined ? error : writeFailed(path, code);
  }
}

const PATH_CONFLICT_CODES = new Set(['EEXIST', 'ENOTDIR', 'EISDIR']);

// Two drop paths can name the same local entry, such as a file and a directory of one
// name, or names differing only in case on a case-insensitive filesystem.
async function writeDropFile(body: AsyncIterable<Uint8Array>, staging: string, path: string, origin: string) {
  const target = join(staging, path);
  try {
    await mkdir(dirname(target), { recursive: true });
    return await writeBody(body, target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === undefined) throw error;
    if (!PATH_CONFLICT_CODES.has(code)) throw writeFailed(target, code);
    throw new DropsCliError({
      code: 'path_conflict',
      message: 'Two files in the drop map to the same local path',
      details: { path },
      instance: origin,
      exitCode: 6,
    });
  }
}

async function download(
  dependencies: PullDependencies,
  instance: { origin: string; token: string },
  drop: { owner: string; name: string },
  directory: string,
): Promise<PullResult> {
  const { origin, token } = instance;
  const listing = await dependencies.api.readDropFiles(origin, token, drop.owner, drop.name);
  const unsafe = listing.files.find((file) => !isSafeRelativePath(file.path));
  if (unsafe !== undefined) {
    throw new DropsCliError({
      code: 'unsafe_path',
      message: 'The instance returned an unsafe file path',
      details: { path: unsafe.path },
      instance: origin,
      exitCode: 6,
    });
  }

  const staging = join(dirname(directory), `.${basename(directory)}.drops-pull-${randomUUID()}`);
  await localWrite(directory, () => mkdir(staging));
  const removeStaging = () => rm(staging, { recursive: true, force: true });
  const unregister = dependencies.registerCleanup?.(removeStaging);
  try {
    let byteSize = 0;
    for (const file of listing.files) {
      const body = await dependencies.api.readDropFile(origin, token, {
        ...drop,
        path: file.path,
        ...(listing.versionId === null ? {} : { versionId: listing.versionId }),
      });
      byteSize += await writeDropFile(body, staging, file.path, origin);
    }
    await localWrite(directory, () => rename(staging, directory));
    return {
      instance: origin,
      ...drop,
      versionId: listing.versionId,
      directory,
      fileCount: listing.files.length,
      byteSize,
    };
  } catch (error) {
    await removeStaging();
    throw error;
  } finally {
    unregister?.();
  }
}

export async function pull(
  options: PullOptions,
  dependencies: PullDependencies = createPullDependencies(),
): Promise<PullResult> {
  const reference = parseDropReference(options.reference, 'drops pull preview');
  const directory = resolve(options.cwd, options.directory ?? reference.name);
  await assertEmptyOrMissing(directory);
  const instance = await authenticatedInstance(options, dependencies, 'reading drops');
  const drop = {
    owner: await resolveOwner(dependencies.api, instance.origin, instance.token, reference),
    name: reference.name,
  };
  await localWrite(directory, () => mkdir(dirname(directory), { recursive: true }));
  try {
    return await download(dependencies, instance, drop, directory);
  } catch (error) {
    // A redeploy mid-pull invalidates the version being fetched; one fresh attempt reads the new one.
    if (!(error instanceof DropsCliError) || error.code !== 'version_changed') throw error;
    return await download(dependencies, instance, drop, directory);
  }
}
