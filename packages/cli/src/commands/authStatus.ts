// ABOUTME: Parses auth-status instance selection and invokes identity validation with stale-token cleanup.
// ABOUTME: Allows repository configuration only when no positional or flag origin is supplied.
import { parseArgs } from 'node:util';

import { authStatus, type AuthDependencies } from '../auth.js';
import { argumentErrorMessage, commandUsageError } from '../help.js';

export interface ParsedAuthStatusArguments {
  instance?: string;
  json: boolean;
}

export function parseAuthStatusArguments(argv: string[]): ParsedAuthStatusArguments {
  const instanceOccurrences = argv.filter(
    (argument) => argument === '--instance' || argument.startsWith('--instance='),
  ).length;
  if (instanceOccurrences > 1) throw commandUsageError('auth status', 'Provide --instance at most once.');
  const jsonOccurrences = argv.filter((argument) => argument === '--json').length;
  if (jsonOccurrences > 1) throw commandUsageError('auth status', 'Provide --json at most once.');
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
    if (error instanceof TypeError) throw commandUsageError('auth status', argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length > 1) throw commandUsageError('auth status', 'Provide at most one instance origin.');
  if (parsed.positionals.length === 1 && parsed.values.instance !== undefined) {
    throw commandUsageError('auth status', 'Choose either a positional origin or --instance, not both.');
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
