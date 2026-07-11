// ABOUTME: Parses auth-status instance selection and invokes identity validation with stale-token cleanup.
// ABOUTME: Allows repository configuration only when no positional or flag origin is supplied.
import { parseArgs } from 'node:util';

import { authStatus, type AuthDependencies } from '../auth.js';
import { DropsCliError } from '../errors.js';

const USAGE = 'Usage: drops auth status [origin] [--instance <origin>] [--json]';

function usage(message: string): DropsCliError {
  return new DropsCliError({ code: 'usage_error', message, exitCode: 2 });
}

export interface ParsedAuthStatusArguments {
  instance?: string;
  json: boolean;
}

export function parseAuthStatusArguments(argv: string[]): ParsedAuthStatusArguments {
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

export async function runAuthStatusCommand(
  options: ParsedAuthStatusArguments & { cwd: string },
  dependencies?: AuthDependencies,
) {
  return authStatus({ cwd: options.cwd, instance: options.instance }, dependencies);
}
