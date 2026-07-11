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

function isolatedKeychainRunner(
  keychainPath: string,
  originalDefault: string,
  originalSearchList: string[],
): ProcessRunner {
  return async (request: ProcessRequest) => {
    const args = [...request.args];
    if (args[0] === 'add-generic-password') {
      await setSearchList([keychainPath]);
      requireSuccess(
        await runProcess({
          command: '/usr/bin/security',
          args: ['default-keychain', '-d', 'user', '-s', keychainPath],
        }),
        'temporary default selection',
      );
      try {
        return await runProcess(request);
      } finally {
        try {
          requireSuccess(
            await runProcess({
              command: '/usr/bin/security',
              args: ['default-keychain', '-d', 'user', '-s', originalDefault],
            }),
            'default restoration',
          );
        } finally {
          await setSearchList(originalSearchList);
        }
      }
    } else if (args[0] === 'find-generic-password' || args[0] === 'delete-generic-password') {
      args.push(keychainPath);
    }
    return runProcess({ ...request, args });
  };
}

describe.skipIf(process.platform !== 'darwin')('MacOsKeychainStore live round trip', () => {
  it('sets, gets, overwrites, and deletes exact values in an isolated temporary keychain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drops-cli-keychain-'));
    const keychainPath = join(directory, 'test.keychain-db');
    const keychainPassword = randomUUID();
    const origin = `https://${randomUUID()}.example.test`;
    const firstToken = `drops_cli_${randomUUID().replaceAll('-', '')}`;
    const secondToken = `drops_cli_${randomUUID().replaceAll('-', '')}`;
    let store: MacOsKeychainStore | undefined;
    let originalDefault: string | undefined;
    let originalSearchList: string[] | undefined;

    try {
      originalDefault = parseDefaultKeychain(
        await runProcess({ command: '/usr/bin/security', args: ['default-keychain', '-d', 'user'] }),
      );
      originalSearchList = parseKeychainList(
        await runProcess({ command: '/usr/bin/security', args: ['list-keychains', '-d', 'user'] }),
      );
      requireSuccess(
        await runProcess({
          command: '/usr/bin/security',
          args: ['create-keychain', '-p', keychainPassword, keychainPath],
        }),
        'creation',
      );
      requireSuccess(
        await runProcess({
          command: '/usr/bin/security',
          args: ['unlock-keychain', '-p', keychainPassword, keychainPath],
        }),
        'unlock',
      );

      store = new MacOsKeychainStore(isolatedKeychainRunner(keychainPath, originalDefault, originalSearchList));
      await store.set(origin, firstToken);
      await expect(store.get(origin)).resolves.toBe(firstToken);
      await store.set(origin, secondToken);
      await expect(store.get(origin)).resolves.toBe(secondToken);
      await store.delete(origin);
      await expect(store.get(origin)).resolves.toBeNull();
    } finally {
      if (originalDefault !== undefined) {
        await runProcess({
          command: '/usr/bin/security',
          args: ['default-keychain', '-d', 'user', '-s', originalDefault],
        }).catch(() => undefined);
      }
      if (originalSearchList !== undefined) {
        await setSearchList(originalSearchList).catch(() => undefined);
      }
      if (store !== undefined) {
        try {
          await store.delete(origin);
        } catch {
          // Deleting the disposable keychain below is the final cleanup boundary.
        }
      }
      await runProcess({ command: '/usr/bin/security', args: ['delete-keychain', keychainPath] }).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
