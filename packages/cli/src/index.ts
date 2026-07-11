#!/usr/bin/env node
// ABOUTME: Parses Drops CLI commands and applies the shared output and process-exit contract.
// ABOUTME: Currently exposes repository instance initialisation while later commands remain explicit usage errors.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseDeployArguments, runDeployCommand } from './commands/deploy.js';
import { runInitCommand } from './commands/init.js';
import type { DeployDependencies } from './deploy.js';
import { DropsCliError } from './errors.js';
import { createOutput, type TextWriter } from './output.js';
import { runLifecycleCleanups } from './packageSource.js';

export interface CliRuntime {
  cwd: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export interface CliDependencies {
  deploy?: DeployDependencies;
}

interface CommandResult {
  value: Record<string, unknown>;
  human: string;
}

export type CommandDispatcher = (
  argv: string[],
  cwd: string,
  diagnostic?: (message: string) => void,
  dependencies?: CliDependencies,
) => Promise<CommandResult>;

let signalHandlersInstalled = false;

export function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const install = (signal: 'SIGINT' | 'SIGTERM', exitCode: number) => {
    process.once(signal, () => {
      void runLifecycleCleanups().finally(() => process.exit(exitCode));
    });
  };
  install('SIGINT', 130);
  install('SIGTERM', 143);
}

function usageError(code: string, message: string): DropsCliError {
  return new DropsCliError({ code, message, exitCode: 2 });
}

function normaliseError(error: unknown): DropsCliError {
  if (error instanceof DropsCliError) return error;
  return new DropsCliError({ code: 'internal_error', message: 'Unexpected CLI error', exitCode: 6 });
}

const dispatch: CommandDispatcher = async (argv, cwd, diagnostic = () => {}, dependencies = {}) => {
  const command = argv[0];
  if (command === undefined) {
    throw usageError('command_required', 'Usage: drops <command>');
  }

  if (command === 'deploy') {
    const parsed = parseDeployArguments(argv.slice(1));
    const result = await runDeployCommand(
      {
        ...parsed,
        cwd,
        onProgress: (uploadedBytes, totalBytes) => {
          const percentage = totalBytes === 0 ? 100 : Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
          diagnostic(`Uploading ${percentage}% (${uploadedBytes}/${totalBytes} bytes)`);
        },
      },
      dependencies.deploy,
    );
    return { value: { ...result }, human: result.url };
  }

  if (command !== 'init') {
    throw usageError('command_not_implemented', `Command ${command} is not implemented yet`);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        instance: { type: 'string' },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    if (error instanceof TypeError) throw usageError('usage_error', error.message);
    throw error;
  }

  if (parsed.values.instance === undefined) {
    throw usageError('instance_required', 'Usage: drops init --instance <origin> [--force] [--json]');
  }

  const result = await runInitCommand({
    cwd,
    instance: parsed.values.instance,
    force: parsed.values.force,
  });
  return { value: result, human: `Configured ${result.path} for ${result.instance}` };
};

export async function runCli(
  argv: string[],
  runtime: CliRuntime,
  commandDispatcher: CommandDispatcher = dispatch,
  dependencies: CliDependencies = {},
): Promise<number> {
  const output = createOutput({ json: argv.includes('--json'), stdout: runtime.stdout, stderr: runtime.stderr });

  try {
    const result = await commandDispatcher(argv, runtime.cwd, output.diagnostic, dependencies);
    return output.success(result.value, result.human);
  } catch (error) {
    return output.error(normaliseError(error));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installSignalHandlers();
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
