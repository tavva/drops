// ABOUTME: Restores and verifies macOS Keychain preferences before live-test cleanup.
// ABOUTME: Preserves disposable recovery state and emits non-secret instructions on any failure.
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../src/keychain.js';

export interface KeychainPreferenceState {
  defaultKeychain: string;
  searchList: string[];
}

export interface RestorePreferencesThenCleanupOptions {
  runner: ProcessRunner;
  original: KeychainPreferenceState;
  recoveryPath: string;
  cleanup: () => Promise<void>;
}

function parseQuotedLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'string') throw new Error('invalid output');
      return parsed;
    });
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function restorePreferencesThenCleanup(
  options: RestorePreferencesThenCleanupOptions,
): Promise<void> {
  const failures: string[] = [];

  async function run(label: string, request: ProcessRequest): Promise<ProcessResult | null> {
    try {
      const result = await options.runner(request);
      if (result.exitCode !== 0) failures.push(`${label} exited ${result.exitCode}`);
      return result;
    } catch {
      failures.push(`${label} could not run`);
      return null;
    }
  }

  await run('default restoration', {
    command: '/usr/bin/security',
    args: ['default-keychain', '-d', 'user', '-s', options.original.defaultKeychain],
  });
  const sentinelPath = `${options.recoveryPath}.restore-sentinel`;
  if (options.original.searchList.length === 0) {
    await run('empty-search sentinel creation', {
      command: '/usr/bin/security',
      args: ['create-keychain', '-p', '', sentinelPath],
    });
    await run('empty-search sentinel selection', {
      command: '/usr/bin/security',
      args: ['list-keychains', '-d', 'user', '-s', sentinelPath],
    });
    await run('empty-search sentinel deletion', {
      command: '/usr/bin/security',
      args: ['delete-keychain', sentinelPath],
    });
  } else {
    await run('search-list restoration', {
      command: '/usr/bin/security',
      args: ['list-keychains', '-d', 'user', '-s', ...options.original.searchList],
    });
  }

  const defaultResult = await run('default verification', {
    command: '/usr/bin/security',
    args: ['default-keychain', '-d', 'user'],
  });
  const searchResult = await run('search-list verification', {
    command: '/usr/bin/security',
    args: ['list-keychains', '-d', 'user'],
  });

  if (defaultResult?.exitCode === 0) {
    try {
      const defaults = parseQuotedLines(defaultResult.stdout);
      if (defaults.length !== 1 || defaults[0] !== options.original.defaultKeychain) {
        failures.push('default verification did not match');
      }
    } catch {
      failures.push('default verification output was invalid');
    }
  }
  if (searchResult?.exitCode === 0) {
    try {
      const searchList = parseQuotedLines(searchResult.stdout);
      if (!arraysEqual(searchList, options.original.searchList)) {
        failures.push('search-list verification did not match');
      }
    } catch {
      failures.push('search-list verification output was invalid');
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        `Keychain preference restoration failed: ${failures.join('; ')}.`,
        `Disposable keychain preserved at ${options.recoveryPath}.`,
        `Expected default: ${options.original.defaultKeychain}.`,
        `Expected search list: ${JSON.stringify(options.original.searchList)}.`,
        ...(options.original.searchList.length === 0 ? [`Empty-search sentinel path: ${sentinelPath}.`] : []),
        'Restore these preferences before deleting the disposable keychain.',
      ].join(' '),
    );
  }

  await options.cleanup();
}
