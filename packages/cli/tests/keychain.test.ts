// ABOUTME: Verifies secure, per-instance macOS Keychain credential storage behavior.
// ABOUTME: Ensures bearer secrets travel only over stdin and never leak through failures.
import { describe, expect, it } from 'vitest';

import { MacOsKeychainStore, type ProcessRequest, type ProcessResult } from '../src/keychain.js';

function recordingRunner(results: ProcessResult[]) {
  const requests: ProcessRequest[] = [];
  return {
    requests,
    runner: async (request: ProcessRequest): Promise<ProcessResult> => {
      requests.push(request);
      const result = results.shift();
      if (result === undefined) throw new Error('No test result configured');
      return result;
    },
  };
}

describe('MacOsKeychainStore', () => {
  it('gets the credential for the exact origin account', async () => {
    const harness = recordingRunner([{ exitCode: 0, stdout: 'drops_cli_token\n', stderr: '' }]);
    const store = new MacOsKeychainStore(harness.runner);

    await expect(store.get('https://one.example.com')).resolves.toBe('drops_cli_token');
    expect(harness.requests).toEqual([
      {
        command: 'security',
        args: [
          'find-generic-password',
          '-a',
          'https://one.example.com',
          '-s',
          'global.drops.cli',
          '-w',
        ],
      },
    ]);
  });

  it('keeps credentials isolated by canonical origin', async () => {
    const harness = recordingRunner([
      { exitCode: 0, stdout: 'first\n', stderr: '' },
      { exitCode: 0, stdout: 'second\n', stderr: '' },
    ]);
    const store = new MacOsKeychainStore(harness.runner);

    await expect(store.get('https://one.example.com')).resolves.toBe('first');
    await expect(store.get('https://two.example.com')).resolves.toBe('second');
    expect(harness.requests.map((request) => request.args[2])).toEqual([
      'https://one.example.com',
      'https://two.example.com',
    ]);
  });

  it('returns null when the item does not exist', async () => {
    const harness = recordingRunner([
      { exitCode: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found.' },
    ]);

    await expect(new MacOsKeychainStore(harness.runner).get('https://one.example.com')).resolves.toBeNull();
  });

  it('writes the secret through stdin with prompt mode last', async () => {
    const token = 'drops_cli_super_secret';
    const harness = recordingRunner([{ exitCode: 0, stdout: '', stderr: '' }]);

    await new MacOsKeychainStore(harness.runner).set('https://one.example.com', token);

    expect(harness.requests).toEqual([
      {
        command: 'security',
        args: [
          'add-generic-password',
          '-a',
          'https://one.example.com',
          '-s',
          'global.drops.cli',
          '-U',
          '-w',
        ],
        stdin: token,
      },
    ]);
    expect(harness.requests[0]?.args).not.toContain(token);
  });

  it('deletes only the exact origin item and treats a missing item idempotently', async () => {
    const harness = recordingRunner([
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 44, stdout: '', stderr: 'could not be found' },
    ]);
    const store = new MacOsKeychainStore(harness.runner);

    await expect(store.delete('https://one.example.com')).resolves.toBeUndefined();
    await expect(store.delete('https://two.example.com')).resolves.toBeUndefined();
    expect(harness.requests.map((request) => request.args)).toEqual([
      ['delete-generic-password', '-a', 'https://one.example.com', '-s', 'global.drops.cli'],
      ['delete-generic-password', '-a', 'https://two.example.com', '-s', 'global.drops.cli'],
    ]);
  });

  it('maps permission and tool failures without exposing secrets', async () => {
    const token = 'drops_cli_do_not_expose';
    const harness = recordingRunner([{ exitCode: 128, stdout: '', stderr: `User interaction is not allowed: ${token}` }]);

    let thrown: unknown;
    try {
      await new MacOsKeychainStore(harness.runner).set('https://one.example.com', token);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'keychain_unavailable', exitCode: 3 });
    expect(String(thrown)).not.toContain(token);
    expect(JSON.stringify(thrown)).not.toContain(token);
  });

  it('maps runner failures without reusing their potentially secret-bearing message', async () => {
    const token = 'drops_cli_do_not_expose';
    const store = new MacOsKeychainStore(async () => {
      throw new Error(`spawn failed while writing ${token}`);
    });

    await expect(store.set('https://one.example.com', token)).rejects.toMatchObject({
      code: 'keychain_unavailable',
      exitCode: 3,
      message: 'macOS Keychain is unavailable',
    });
  });
});
