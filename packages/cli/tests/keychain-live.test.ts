// ABOUTME: Verifies fail-loud restoration and cleanup ordering for the live Keychain harness.
// ABOUTME: Ensures disposable state is preserved whenever exact preference recovery cannot be proven.
import { describe, expect, it, vi } from 'vitest';

import { restorePreferencesThenCleanup, type KeychainPreferenceState } from './helpers/keychain-live.js';
import type { ProcessRequest, ProcessResult } from '../src/keychain.js';

function runnerWith(results: ProcessResult[]) {
  const requests: ProcessRequest[] = [];
  return {
    requests,
    runner: async (request: ProcessRequest): Promise<ProcessResult> => {
      requests.push(request);
      const result = results.shift();
      if (result === undefined) throw new Error('No result configured');
      return result;
    },
  };
}

const original: KeychainPreferenceState = {
  defaultKeychain: '/Users/test/Library/Keychains/login.keychain-db',
  searchList: ['/Users/test/Library/Keychains/login.keychain-db'],
};

describe('restorePreferencesThenCleanup', () => {
  it('verifies exact restored state before cleanup', async () => {
    const harness = runnerWith([
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: `    "${original.defaultKeychain}"\n`, stderr: '' },
      { exitCode: 0, stdout: `    "${original.searchList[0]}"\n`, stderr: '' },
    ]);
    const cleanup = vi.fn(async () => undefined);

    await restorePreferencesThenCleanup({
      runner: harness.runner,
      original,
      recoveryPath: '/tmp/disposable.keychain-db',
      cleanup,
    });

    expect(harness.requests.map((request) => request.args[0])).toEqual([
      'default-keychain',
      'list-keychains',
      'default-keychain',
      'list-keychains',
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('restores an empty search list through a disposable sentinel before cleanup', async () => {
    const harness = runnerWith([
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: `    "${original.defaultKeychain}"\n`, stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    ]);
    const cleanup = vi.fn(async () => undefined);

    await restorePreferencesThenCleanup({
      runner: harness.runner,
      original: { ...original, searchList: [] },
      recoveryPath: '/tmp/disposable.keychain-db',
      cleanup,
    });

    expect(harness.requests.map((request) => request.args[0])).toEqual([
      'default-keychain',
      'create-keychain',
      'list-keychains',
      'delete-keychain',
      'default-keychain',
      'list-keychains',
    ]);
    expect(harness.requests[2]?.args.at(-1)).toBe('/tmp/disposable.keychain-db.restore-sentinel');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('attempts and verifies both restorations, preserves disposable state, and fails with recovery details', async () => {
    const harness = runnerWith([
      { exitCode: 1, stdout: '', stderr: 'sensitive diagnostic omitted' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '    "/tmp/disposable.keychain-db"\n', stderr: '' },
      { exitCode: 0, stdout: `    "${original.searchList[0]}"\n`, stderr: '' },
    ]);
    const cleanup = vi.fn(async () => undefined);

    let thrown: unknown;
    try {
      await restorePreferencesThenCleanup({
        runner: harness.runner,
        original,
        recoveryPath: '/tmp/disposable.keychain-db',
        cleanup,
      });
    } catch (error) {
      thrown = error;
    }

    expect(harness.requests).toHaveLength(4);
    expect(cleanup).not.toHaveBeenCalled();
    expect(thrown).toMatchObject({
      message: expect.stringContaining('Disposable keychain preserved at /tmp/disposable.keychain-db'),
    });
    expect(String(thrown)).toContain(`Expected default: ${original.defaultKeychain}`);
    expect(String(thrown)).not.toContain('sensitive diagnostic omitted');
  });
});
