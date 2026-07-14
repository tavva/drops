// ABOUTME: Verifies secure, per-instance macOS Keychain credential storage behavior.
// ABOUTME: Ensures bearer secrets travel only over stdin and never leak through failures.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  MacOsKeychainStore,
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from '../src/keychain.js';

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
  it('detaches the security subprocess so it cannot prompt on the controlling terminal', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    spawnMock.mockReturnValueOnce(child);

    const pending = runProcess({
      command: '/usr/bin/security',
      args: ['add-generic-password', '-w'],
      stdin: 'secret\nsecret\n',
    });
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['add-generic-password', '-w'],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });

  it('gets the credential for the exact origin account', async () => {
    const harness = recordingRunner([{ exitCode: 0, stdout: 'drops_cli_token\n', stderr: '' }]);
    const store = new MacOsKeychainStore(harness.runner);

    await expect(store.get('https://one.example.com')).resolves.toBe('drops_cli_token');
    expect(harness.requests).toEqual([
      {
        command: '/usr/bin/security',
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
    const harness = recordingRunner([
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: `${token}\n`, stderr: '' },
    ]);

    await new MacOsKeychainStore(harness.runner).set('https://one.example.com', token);

    expect(harness.requests).toHaveLength(2);
    expect({ command: harness.requests[0]?.command, args: harness.requests[0]?.args }).toEqual({
      command: '/usr/bin/security',
      args: [
        'add-generic-password',
        '-a',
        'https://one.example.com',
        '-s',
        'global.drops.cli',
        '-U',
        '-w',
      ],
    });
    expect(harness.requests[0]?.stdin === `${token}\n${token}\n`).toBe(true);
    expect(harness.requests[1]).toEqual({
        command: '/usr/bin/security',
        args: [
          'find-generic-password',
          '-a',
          'https://one.example.com',
          '-s',
          'global.drops.cli',
          '-w',
        ],
      });
    expect(harness.requests[0]?.args).not.toContain(token);
  });

  it.each(['', 'different-token'])('deletes an unverifiable write when read-back returns %j', async (readBack) => {
    const token = 'drops_cli_super_secret';
    const harness = recordingRunner([
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: `${readBack}\n`, stderr: '' },
      { exitCode: 128, stdout: '', stderr: 'cleanup failed' },
    ]);

    await expect(new MacOsKeychainStore(harness.runner).set('https://one.example.com', token)).rejects.toMatchObject({
      code: 'keychain_unavailable',
      exitCode: 3,
    });
    expect(harness.requests[2]).toEqual({
      command: '/usr/bin/security',
      args: ['delete-generic-password', '-a', 'https://one.example.com', '-s', 'global.drops.cli'],
    });
    expect(JSON.stringify(harness.requests[2])).not.toContain(token);
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
