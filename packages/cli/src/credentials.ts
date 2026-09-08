// ABOUTME: Selects native macOS storage or private credential files for headless Linux.
// ABOUTME: Isolates exact origins and writes tokens atomically with owner-only permissions.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { DropsCliError } from './errors.js';
import { MacOsKeychainStore, type CredentialStore } from './keychain.js';

function unavailable(): DropsCliError {
  return new DropsCliError({
    code: 'credential_store_unavailable',
    message: 'The local credential store is unavailable',
    guidance: { hint: 'Ensure the Drops credential directory is owned by you with mode 0700 and its files have mode 0600.' },
    exitCode: 3,
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function credentialDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const config = env.XDG_CONFIG_HOME;
  return join(config && isAbsolute(config) ? config : join(home, '.config'), 'drops', 'credentials');
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly directory = credentialDirectory()) {}

  private path(origin: string): string {
    return join(this.directory, `${createHash('sha256').update(origin).digest('hex')}.json`);
  }

  private async checkDirectory(create = false): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
      throw unavailable();
    }
  }

  async get(origin: string): Promise<string | null> {
    try {
      await this.checkDirectory();
      const file = await open(this.path(origin), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 8192) {
          throw unavailable();
        }
        const value: unknown = JSON.parse(await file.readFile('utf8'));
        if (typeof value !== 'object' || value === null || !('origin' in value) || value.origin !== origin ||
            !('token' in value) || typeof value.token !== 'string' || value.token.length === 0) {
          throw unavailable();
        }
        return value.token;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (missing(error)) return null;
      throw unavailable();
    }
  }

  async set(origin: string, token: string): Promise<void> {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let created = false;
    try {
      await this.checkDirectory(true);
      const file = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await file.writeFile(JSON.stringify({ origin, token }), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path(origin));
    } catch {
      throw unavailable();
    } finally {
      if (created) await unlink(temporary).catch(() => {});
    }
  }

  async delete(origin: string): Promise<void> {
    try {
      await this.checkDirectory();
      await unlink(this.path(origin));
    } catch (error) {
      if (!missing(error)) throw unavailable();
    }
  }
}

export function createCredentialStore(platform: NodeJS.Platform = process.platform): CredentialStore {
  if (platform === 'darwin') return new MacOsKeychainStore();
  if (platform === 'linux') return new FileCredentialStore();
  const fail = async (): Promise<never> => {
    throw new DropsCliError({ code: 'unsupported_platform', message: 'The Drops CLI supports macOS and Linux', exitCode: 3 });
  };
  return { get: fail, set: fail, delete: fail };
}
