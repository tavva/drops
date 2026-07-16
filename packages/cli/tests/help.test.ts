// ABOUTME: Verifies that the installed CLI teaches its workflow without repository documentation.
// ABOUTME: Covers equivalent human and machine-readable root and command help entry points.
import { describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

interface Capture {
  stdout: string;
  stderr: string;
}

async function invoke(argv: string[]): Promise<Capture & { exitCode: number }> {
  const capture: Capture = { stdout: '', stderr: '' };
  const exitCode = await runCli(argv, {
    cwd: '/repo',
    stdout: { write: (value) => (capture.stdout += value) },
    stderr: { write: (value) => (capture.stderr += value) },
  });
  return { ...capture, exitCode };
}

describe('root help', () => {
  it.each([{ argv: [] }, { argv: ['--help'] }, { argv: ['help'] }])('prints a complete human quick start for $argv', async ({ argv }) => {
    const result = await invoke(argv);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Drops CLI');
    expect(result.stdout).toContain('Quick start:');
    expect(result.stdout).toContain('drops login https://drops.example.com');
    expect(result.stdout).toContain('drops init --instance https://drops.example.com');
    expect(result.stdout).toContain('drops deploy ./dist --name preview');
    for (const command of ['login', 'init', 'deploy', 'list', 'auth status', 'logout']) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain('drops help --json');
  });

  it.each([{ argv: ['help', '--json'] }, { argv: ['--help', '--json'] }, { argv: ['--json'] }])(
    'returns the versioned command catalogue for $argv',
    async ({ argv }) => {
      const result = await invoke(argv);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const help = JSON.parse(result.stdout);
      expect(help).toMatchObject({ helpVersion: 1, cli: 'drops' });
      expect(help.quickStart).toContain('drops deploy ./dist --name preview');
      expect(help.commands.map((command: { name: string }) => command.name)).toEqual([
        'login',
        'init',
        'deploy',
        'list',
        'auth status',
        'logout',
      ]);
      expect(help.commands[3]).toMatchObject({
        name: 'list',
        usage: 'drops list [name] [--instance <origin>] [--json]',
      });
      expect(help.commands[2]).toMatchObject({
        name: 'deploy',
        usage: 'drops deploy <path> --name <name> [--instance <origin>] [--json]',
      });
      expect(help.commands[2].options.length).toBeGreaterThan(0);
      expect(help.commands[2].examples.length).toBeGreaterThan(0);
    },
  );
});

describe('command help', () => {
  it.each([
    [['deploy', '--help'], 'deploy'],
    [['help', 'deploy'], 'deploy'],
    [['auth', 'status', '--help'], 'auth status'],
    [['help', 'auth', 'status'], 'auth status'],
    [['list', '--help'], 'list'],
    [['help', 'list'], 'list'],
    [['login', '--help'], 'login'],
    [['init', '--help'], 'init'],
    [['logout', '--help'], 'logout'],
  ] as const)('prints focused human help for %j', async (argv, command) => {
    const result = await invoke([...argv]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`drops ${command}`);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('Options:');
    expect(result.stdout).toContain('Examples:');
    expect(result.stdout).not.toContain('Quick start:');
  });

  it.each([
    ['help', 'deploy', '--json'],
    ['deploy', '--help', '--json'],
  ])('returns one structured command document for %j', async (...argv) => {
    const result = await invoke(argv);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      helpVersion: 1,
      cli: 'drops',
      command: {
        name: 'deploy',
        summary: expect.any(String),
        usage: 'drops deploy <path> --name <name> [--instance <origin>] [--json]',
        arguments: expect.any(Array),
        options: expect.any(Array),
        examples: expect.any(Array),
        notes: expect.any(Array),
      },
    });
  });
});
