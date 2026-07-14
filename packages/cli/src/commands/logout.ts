// ABOUTME: Parses logout instance selection and invokes revoke-before-delete orchestration.
// ABOUTME: Rejects ambiguous positional and flag origins before touching credentials.
import { parseArgs } from 'node:util';

import { logout, type AuthDependencies } from '../auth.js';
import { argumentErrorMessage, commandUsageError } from '../help.js';

export interface ParsedLogoutArguments {
  instance?: string;
  json: boolean;
}

export function parseLogoutArguments(argv: string[]): ParsedLogoutArguments {
  const instanceOccurrences = argv.filter(
    (argument) => argument === '--instance' || argument.startsWith('--instance='),
  ).length;
  if (instanceOccurrences > 1) throw commandUsageError('logout', 'Provide --instance at most once.');
  const jsonOccurrences = argv.filter((argument) => argument === '--json').length;
  if (jsonOccurrences > 1) throw commandUsageError('logout', 'Provide --json at most once.');
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
    if (error instanceof TypeError) throw commandUsageError('logout', argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length > 1) throw commandUsageError('logout', 'Provide at most one instance origin.');
  if (parsed.positionals.length === 1 && parsed.values.instance !== undefined) {
    throw commandUsageError('logout', 'Choose either a positional origin or --instance, not both.');
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
