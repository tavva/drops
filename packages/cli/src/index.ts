#!/usr/bin/env node
// ABOUTME: Parses Drops CLI commands and applies the shared output and process-exit contract.
// ABOUTME: Exposes repository setup, persistent browser authentication, and authenticated deployment.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createAuthDependencies, type AuthDependencies } from './auth.js';
import { parseAuthStatusArguments, runAuthStatusCommand } from './commands/authStatus.js';
import { parseDeployArguments, runDeployCommand } from './commands/deploy.js';
import { runInitCommand } from './commands/init.js';
import {
  parseListArguments,
  renderDropFiles,
  renderDropsList,
  runListCommand,
} from './commands/list.js';
import { parseLoginArguments, runLoginCommand } from './commands/login.js';
import { parseLogoutArguments, runLogoutCommand } from './commands/logout.js';
import { createDeployDependencies, type DeployDependencies } from './deploy.js';
import { DropsCliError } from './errors.js';
import {
  commandHelpValue,
  argumentErrorMessage,
  commandUsageError,
  parseHelpRequest,
  renderCommandHelp,
  renderRootHelp,
  rootHelpValue,
  rootGuidance,
} from './help.js';
import { createLifecycleRegistry, type LifecycleRegistry } from './lifecycle.js';
import { createListDependencies, type ListDependencies } from './list.js';
import { createOutput, type TextWriter } from './output.js';

export interface CliRuntime {
  cwd: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export interface CliDependencies {
  deploy?: DeployDependencies;
  auth?: AuthDependencies;
  list?: ListDependencies;
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

export function installSignalHandlers(lifecycle: Pick<LifecycleRegistry, 'cleanup'>): void {
  let shutdown: Promise<void> | undefined;
  const install = (signal: 'SIGINT' | 'SIGTERM', exitCode: number) => {
    process.on(signal, () => {
      if (shutdown !== undefined) return;
      shutdown = lifecycle.cleanup().finally(() => process.exit(exitCode));
    });
  };
  install('SIGINT', 130);
  install('SIGTERM', 143);
}

function normaliseError(error: unknown): DropsCliError {
  if (error instanceof DropsCliError) return error;
  return new DropsCliError({ code: 'internal_error', message: 'Unexpected CLI error', exitCode: 6 });
}

const dispatch: CommandDispatcher = async (argv, cwd, diagnostic = () => {}, dependencies = {}) => {
  const help = parseHelpRequest(argv);
  if (help !== null) {
    if (help.command === undefined) {
      return { value: rootHelpValue(), human: renderRootHelp() };
    }
    return { value: commandHelpValue(help.command), human: renderCommandHelp(help.command) };
  }

  const command = argv[0];
  if (command === undefined) {
    throw new DropsCliError({ code: 'command_required', message: 'Choose a command.', guidance: rootGuidance(), exitCode: 2 });
  }

  if (command === 'login') {
    const parsed = parseLoginArguments(argv.slice(1));
    const result = await runLoginCommand(
      {
        ...parsed,
        onBrowserOpen: () => diagnostic('Authorising in browser…'),
        onAuthorizeUrl: (url) => diagnostic(`Open this URL if the browser does not open:\n${url}`),
      },
      dependencies.auth,
    );
    return { value: { ...result }, human: `Authenticated to ${result.instance} as ${result.user.username}` };
  }

  if (command === 'logout') {
    const parsed = parseLogoutArguments(argv.slice(1));
    const result = await runLogoutCommand({ ...parsed, cwd }, dependencies.auth);
    return { value: { ...result }, human: `Logged out of ${result.instance}` };
  }

  if (command === 'auth') {
    if (argv[1] !== 'status') {
      throw commandUsageError('auth status', 'The auth command currently supports only auth status.');
    }
    const parsed = parseAuthStatusArguments(argv.slice(2));
    const result = await runAuthStatusCommand({ ...parsed, cwd }, dependencies.auth);
    const human = result.authenticated
      ? `Authenticated to ${result.instance} as ${result.user.username}`
      : `Not authenticated to ${result.instance}`;
    return { value: { ...result }, human };
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
        onWarning: diagnostic,
      },
      dependencies.deploy,
    );
    return { value: { ...result }, human: result.url };
  }

  if (command === 'list') {
    const parsed = parseListArguments(argv.slice(1));
    const result = await runListCommand({ ...parsed, cwd }, dependencies.list);
    const human = 'files' in result ? renderDropFiles(result) : renderDropsList(result);
    return { value: { ...result }, human };
  }

  if (command !== 'init') {
    const shown = command === 'help'
      ? argv.filter((argument) => argument !== '--json').slice(1).join(' ') || 'help'
      : command;
    throw new DropsCliError({
      code: 'unknown_command',
      message: `Unknown command "${shown}".`,
      guidance: rootGuidance(),
      exitCode: 2,
    });
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
    if (error instanceof TypeError) throw commandUsageError('init', argumentErrorMessage(error));
    throw error;
  }

  if (parsed.values.instance === undefined) {
    throw commandUsageError('init', 'Provide the required --instance origin.');
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
  const lifecycle = createLifecycleRegistry();
  installSignalHandlers(lifecycle);
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }, undefined, {
    deploy: createDeployDependencies(lifecycle.register),
    auth: createAuthDependencies(),
    list: createListDependencies(),
  });
}
