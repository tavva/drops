// ABOUTME: Proves secure credential round trips against a disposable real macOS Keychain.
// ABOUTME: Isolates live writes in a temporary keychain file and guarantees teardown.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MacOsKeychainStore,
  runProcess,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from '../src/keychain.js';
import {
  restorePreferencesThenCleanup,
  type KeychainPreferenceState,
} from './helpers/keychain-live.js';

function requireSuccess(result: ProcessResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`Temporary Keychain ${operation} failed with exit ${result.exitCode}`);
}

function parseDefaultKeychain(result: ProcessResult): string {
  requireSuccess(result, 'default-keychain lookup');
  const parsed: unknown = JSON.parse(result.stdout.trim());
  if (typeof parsed !== 'string' || parsed.length === 0) throw new Error('Default Keychain lookup was invalid');
  return parsed;
}

function parseKeychainList(result: ProcessResult): string[] {
  requireSuccess(result, 'search-list lookup');
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'string') throw new Error('Keychain search-list lookup was invalid');
      return parsed;
    });
}

async function setSearchList(keychains: string[]): Promise<void> {
  requireSuccess(
    await runProcess({
      command: '/usr/bin/security',
      args: ['list-keychains', '-d', 'user', '-s', ...keychains],
    }),
    'search-list update',
  );
}

function isolatedKeychainRunner(keychainPath: string): ProcessRunner {
  return async (request: ProcessRequest) => {
    const args = [...request.args];
    if (args[0] === 'find-generic-password' || args[0] === 'delete-generic-password') {
      args.push(keychainPath);
    }
    return runProcess({ ...request, args });
  };
}

const runLiveTest = process.platform === 'darwin' && process.env.DROPS_RUN_KEYCHAIN_INTEGRATION === '1';

describe.sequential('MacOsKeychainStore live round trip', () => {
  it.skipIf(!runLiveTest)(
    'sets, gets, overwrites, and deletes exact values in an isolated temporary keychain',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'drops-cli-keychain-'));
      const keychainPath = join(directory, 'test.keychain-db');
      const keychainPassword = randomUUID();
      const origin = `https://${randomUUID()}.example.test`;
      const firstToken = `drops_cli_${randomUUID().replaceAll('-', '')}`;
      const secondToken = `drops_cli_${randomUUID().replaceAll('-', '')}`;
      let store: MacOsKeychainStore | undefined;
      let original: KeychainPreferenceState | undefined;
      let keychainCreated = false;

      try {
        original = {
          defaultKeychain: parseDefaultKeychain(
            await runProcess({ command: '/usr/bin/security', args: ['default-keychain', '-d', 'user'] }),
          ),
          searchList: parseKeychainList(
            await runProcess({ command: '/usr/bin/security', args: ['list-keychains', '-d', 'user'] }),
          ),
        };
        requireSuccess(
          await runProcess({
            command: '/usr/bin/security',
            args: ['create-keychain', '-p', keychainPassword, keychainPath],
          }),
          'creation',
        );
        keychainCreated = true;
        requireSuccess(
          await runProcess({
            command: '/usr/bin/security',
            args: ['unlock-keychain', '-p', keychainPassword, keychainPath],
          }),
          'unlock',
        );
        await setSearchList([keychainPath]);
        requireSuccess(
          await runProcess({
            command: '/usr/bin/security',
            args: ['default-keychain', '-d', 'user', '-s', keychainPath],
          }),
          'temporary default selection',
        );

        store = new MacOsKeychainStore(isolatedKeychainRunner(keychainPath));
        await store.set(origin, firstToken);
        await expect(store.get(origin)).resolves.toBe(firstToken);
        await store.set(origin, secondToken);
        await expect(store.get(origin)).resolves.toBe(secondToken);
        await store.delete(origin);
        await expect(store.get(origin)).resolves.toBeNull();
      } finally {
        if (original === undefined) {
          await rm(directory, { recursive: true, force: true });
        } else {
          await restorePreferencesThenCleanup({
            runner: runProcess,
            original,
            recoveryPath: keychainPath,
            cleanup: async () => {
              if (store !== undefined) {
                await store.delete(origin);
              }
              if (keychainCreated) {
                const deleted = await runProcess({
                  command: '/usr/bin/security',
                  args: ['delete-keychain', keychainPath],
                });
                if (deleted.exitCode !== 0) {
                  throw new Error(`Disposable keychain deletion failed; preserved at ${keychainPath}`);
                }
              }
              await rm(directory, { recursive: true, force: true });
            },
          });
        }
      }
    },
  );
});
