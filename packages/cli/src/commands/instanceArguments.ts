// ABOUTME: Parses the shared instance-selection argument form used by login, logout, and auth status.
// ABOUTME: Accepts one optional positional origin or --instance, never both, plus --json.
import { parseArgs } from 'node:util';

import { argumentErrorMessage, commandUsageError, type HelpCommandName } from '../help.js';

export interface ParsedInstanceArguments {
  instance?: string;
  json: boolean;
}

export function parseInstanceArguments(command: HelpCommandName, argv: string[]): ParsedInstanceArguments {
  const instanceOccurrences = argv.filter(
    (argument) => argument === '--instance' || argument.startsWith('--instance='),
  ).length;
  if (instanceOccurrences > 1) throw commandUsageError(command, 'Provide --instance at most once.');
  const jsonOccurrences = argv.filter((argument) => argument === '--json').length;
  if (jsonOccurrences > 1) throw commandUsageError(command, 'Provide --json at most once.');
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
    if (error instanceof TypeError) throw commandUsageError(command, argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length > 1) throw commandUsageError(command, 'Provide at most one instance origin.');
  if (parsed.positionals.length === 1 && parsed.values.instance !== undefined) {
    throw commandUsageError(command, 'Choose either a positional origin or --instance, not both.');
  }
  const instance = parsed.positionals[0] ?? parsed.values.instance;
  return { ...(instance === undefined ? {} : { instance }), json: parsed.values.json };
}
