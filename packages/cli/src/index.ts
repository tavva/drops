#!/usr/bin/env node
// ABOUTME: Parses Drops CLI commands and applies the shared output and process-exit contract.
// ABOUTME: Currently exposes repository instance initialisation while later commands remain explicit usage errors.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runInitCommand } from './commands/init.js';
import { DropsCliError } from './errors.js';
import { createOutput, type TextWriter } from './output.js';

export interface CliRuntime {
  cwd: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

function usageError(code: string, message: string): DropsCliError {
  return new DropsCliError({ code, message, exitCode: 2 });
}

function normaliseError(error: unknown): DropsCliError {
  if (error instanceof DropsCliError) return error;
  if (error instanceof TypeError) return usageError('usage_error', error.message);
  return new DropsCliError({ code: 'internal_error', message: 'Unexpected CLI error', exitCode: 6 });
}

async function dispatch(argv: string[], cwd: string): Promise<{ value: Record<string, unknown>; human: string }> {
  const command = argv[0];
  if (command === undefined) {
    throw usageError('command_required', 'Usage: drops init --instance <origin> [--force] [--json]');
  }

  if (command !== 'init') {
    throw usageError('command_not_implemented', `Command ${command} is not implemented yet`);
  }

  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
      instance: { type: 'string' },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (parsed.values.instance === undefined) {
    throw usageError('instance_required', 'Usage: drops init --instance <origin> [--force] [--json]');
  }

  const result = await runInitCommand({
    cwd,
    instance: parsed.values.instance,
    force: parsed.values.force,
  });
  return { value: result, human: `Configured ${result.path} for ${result.instance}` };
}

export async function runCli(argv: string[], runtime: CliRuntime): Promise<number> {
  const output = createOutput({ json: argv.includes('--json'), stdout: runtime.stdout, stderr: runtime.stderr });

  try {
    const result = await dispatch(argv, runtime.cwd);
    return output.success(result.value, result.human);
  } catch (error) {
    return output.error(normaliseError(error));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
