// ABOUTME: Parses logout instance selection and invokes revoke-before-delete orchestration.
// ABOUTME: Rejects ambiguous positional and flag origins before touching credentials.
import { parseArgs } from 'node:util';

import { logout, type AuthDependencies } from '../auth.js';
import { DropsCliError } from '../errors.js';

const USAGE = 'Usage: drops logout [origin] [--instance <origin>] [--json]';

function usage(message: string): DropsCliError {
  return new DropsCliError({ code: 'usage_error', message, exitCode: 2 });
}

export interface ParsedLogoutArguments {
  instance?: string;
  json: boolean;
}

export function parseLogoutArguments(argv: string[]): ParsedLogoutArguments {
  const instanceOccurrences = argv.filter(
    (argument) => argument === '--instance' || argument.startsWith('--instance='),
  ).length;
  if (instanceOccurrences > 1) throw usage(`${USAGE}; provide --instance at most once`);
  const jsonOccurrences = argv.filter((argument) => argument === '--json').length;
  if (jsonOccurrences > 1) throw usage(`${USAGE}; provide --json at most once`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        instance: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof TypeError) throw usage(`${USAGE}; ${error.message}`);
    throw error;
  }
  if (parsed.positionals.length > 1) throw usage(`${USAGE}; provide exactly one origin`);
  if (parsed.positionals.length === 1 && parsed.values.instance !== undefined) {
    throw usage(`${USAGE}; choose either a positional origin or --instance`);
  }
  const instance = parsed.positionals[0] ?? parsed.values.instance;
  return { ...(instance === undefined ? {} : { instance }), json: parsed.values.json };
}

export async function runLogoutCommand(
  options: ParsedLogoutArguments & { cwd: string },
  dependencies?: AuthDependencies,
) {
  return logout({ cwd: options.cwd, instance: options.instance }, dependencies);
}
