// ABOUTME: Verifies the Drops CLI's stable human, JSON, redaction, and exit-code contract.
// ABOUTME: Exercises stdout/stderr isolation and the top-level init command boundary.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DropsCliError, EXIT_CODES } from '../src/errors.js';
import { runCli } from '../src/index.js';
import { createOutput } from '../src/output.js';

interface Capture {
  stdout: string;
  stderr: string;
  io: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
  };
}

function capture(): Capture {
  const result: Capture = {
    stdout: '',
    stderr: '',
    io: {
      stdout: {
        write(chunk: string) {
          result.stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          result.stderr += chunk;
          return true;
        },
      },
    },
  };
  return result;
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'drops-cli-output-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JSON output', () => {
  it('emits exactly one success object and newline on stdout', () => {
    const captured = capture();
    const output = createOutput({ json: true, ...captured.io });

    const exitCode = output.success({ instance: 'https://drops.example.com', authenticated: true });

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(captured.stdout).toBe('{"instance":"https://drops.example.com","authenticated":true}\n');
    expect(captured.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(captured.stderr).toBe('');
  });

  it('treats unauthenticated auth status as success', () => {
    const captured = capture();
    const output = createOutput({ json: true, ...captured.io });

    const exitCode = output.success({
      instance: 'https://drops.example.com',
      authenticated: false,
      user: null,
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout).toBe(
      '{"instance":"https://drops.example.com","authenticated":false,"user":null}\n',
    );
  });

  it('keeps progress on stderr and the result alone on stdout', () => {
    const captured = capture();
    const output = createOutput({ json: true, ...captured.io });

    output.diagnostic('Authorising in browser…');
    output.success({ authenticated: true });

    expect(captured.stdout).toBe('{"authenticated":true}\n');
    expect(captured.stderr).toBe('Authorising in browser…\n');
  });

  it('emits the exact error envelope and redacts bearer-looking tokens', () => {
    const captured = capture();
    const output = createOutput({ json: true, ...captured.io });
    const error = new DropsCliError({
      code: 'not_authenticated',
      message: 'Rejected drops_cli_abcdefghijklmnopqrstuvwxyz0123456789',
      instance: 'https://drops.example.com',
      details: { received: 'Bearer drops_cli_very-secret-token', retryable: false },
      exitCode: 3,
    });

    const exitCode = output.error(error);

    expect(exitCode).toBe(3);
    expect(captured.stdout).toBe(
      '{"error":{"code":"not_authenticated","message":"Rejected [REDACTED]","instance":"https://drops.example.com","details":{"received":"Bearer [REDACTED]","retryable":false},"usage":null,"hint":null,"examples":[]}}\n',
    );
    expect(captured.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(captured.stderr).toBe('');
  });
});

describe('human output', () => {
  it('writes readable successes to stdout and failures to stderr', () => {
    const captured = capture();
    const output = createOutput({ json: false, ...captured.io });

    output.success({ path: '/repo/.drops.json' }, 'Configured /repo/.drops.json');
    output.error(new DropsCliError({ code: 'instance_required', message: 'Run drops init', exitCode: 2 }));

    expect(captured.stdout).toBe('Configured /repo/.drops.json\n');
    expect(captured.stderr).toBe('Error [instance_required]: Run drops init\n');
  });

  it('renders actionable guidance for humans without putting it on stdout', () => {
    const captured = capture();
    const output = createOutput({ json: false, ...captured.io });

    output.error(new DropsCliError({
      code: 'usage_error',
      message: 'Provide one source path and the required --name.',
      guidance: {
        usage: 'drops deploy <path> --name <name> [--instance <origin>] [--json]',
        hint: 'Run drops deploy --help for full command details.',
        examples: ['drops deploy ./dist --name preview'],
      },
      exitCode: 2,
    }));

    expect(captured.stdout).toBe('');
    expect(captured.stderr).toBe([
      'Error [usage_error]: Provide one source path and the required --name.',
      'Usage: drops deploy <path> --name <name> [--instance <origin>] [--json]',
      'Hint: Run drops deploy --help for full command details.',
      'Examples:',
      '  drops deploy ./dist --name preview',
      '',
    ].join('\n'));
  });
});

describe('exit categories', () => {
  it('exposes every stable coarse exit category', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      usage: 2,
      auth: 3,
      upload: 4,
      network: 5,
      internal: 6,
    });
  });
});

describe('runCli', () => {
  it('implements drops init with JSON output', async () => {
    const cwd = await temporaryDirectory();
    const captured = capture();

    const exitCode = await runCli(['init', '--instance', 'HTTPS://Drops.Example.com/', '--json'], {
      cwd,
      ...captured.io,
    });

    const path = join(cwd, '.drops.json');
    expect(exitCode).toBe(0);
    expect(captured.stdout).toBe(`${JSON.stringify({ path, instance: 'https://drops.example.com' })}\n`);
    expect(captured.stderr).toBe('');
    expect(await readFile(path, 'utf8')).toBe('{"instance":"https://drops.example.com"}\n');
  });

  it('returns a clear JSON usage error when deploy is missing its required path and name', async () => {
    const captured = capture();

    const exitCode = await runCli(['deploy', '--json'], { cwd: process.cwd(), ...captured.io });

    expect(exitCode).toBe(2);
    expect(JSON.parse(captured.stdout)).toEqual({
      error: {
        code: 'usage_error',
        message: 'Provide one source path and the required --name.',
        instance: null,
        details: null,
        usage: 'drops deploy <path> --name <name> [--instance <origin>] [--json]',
        hint: 'Run drops deploy --help for full command details.',
        examples: ['drops deploy ./dist --name preview'],
      },
    });
    expect(captured.stderr).toBe('');
  });

  it('classifies a parseArgs failure as a usage error', async () => {
    const captured = capture();

    const exitCode = await runCli(['init', '--unknown', '--json'], { cwd: process.cwd(), ...captured.io });

    expect(exitCode).toBe(2);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      error: {
        code: 'usage_error',
        instance: null,
        details: null,
        usage: 'drops init --instance <origin> [--force] [--json]',
        hint: 'Run drops init --help for full command details.',
      },
    });
    expect(captured.stderr).toBe('');
  });

  it('classifies an unexpected TypeError as an internal failure', async () => {
    const captured = capture();

    const exitCode = await runCli(
      ['--json'],
      { cwd: process.cwd(), ...captured.io },
      async () => {
        throw new TypeError('unexpected implementation failure');
      },
    );

    expect(exitCode).toBe(6);
    expect(JSON.parse(captured.stdout)).toEqual({
      error: {
        code: 'internal_error',
        message: 'Unexpected CLI error',
        instance: null,
        details: null,
        usage: null,
        hint: null,
        examples: [],
      },
    });
    expect(captured.stderr).toBe('');
  });

  it('explains an unknown command and points agents to machine-readable help', async () => {
    const captured = capture();

    const exitCode = await runCli(['frobnicate', '--json'], { cwd: process.cwd(), ...captured.io });

    expect(exitCode).toBe(2);
    expect(JSON.parse(captured.stdout)).toEqual({
      error: {
        code: 'unknown_command',
        message: 'Unknown command "frobnicate".',
        instance: null,
        details: null,
        usage: 'drops <command> [options]',
        hint: 'Run drops --help for human help or drops help --json for the command catalogue.',
        examples: ['drops --help', 'drops help --json'],
      },
    });
  });

  it.each([
    ['not_authenticated', 3],
    ['path_rejected', 4],
    ['network_error', 5],
  ] as const)('preserves the %s DropsCliError exit category', async (code, expectedExitCode) => {
    const captured = capture();

    const exitCode = await runCli(
      ['--json'],
      { cwd: process.cwd(), ...captured.io },
      async () => {
        throw new DropsCliError({ code, message: 'Expected command failure', exitCode: expectedExitCode });
      },
    );

    expect(exitCode).toBe(expectedExitCode);
    expect(JSON.parse(captured.stdout)).toMatchObject({ error: { code } });
    expect(captured.stderr).toBe('');
  });
});
