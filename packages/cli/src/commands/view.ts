// ABOUTME: Parses terminal and browser viewing commands with a shared drop target and optional path.
// ABOUTME: Supports owner/name for shared drops and explicit instance selection for both commands.
import { parseArgs } from 'node:util';
import { argumentErrorMessage, commandUsageError } from '../help.js';

export function parseViewArguments(command: 'view' | 'open', argv: string[]) {
  if (argv.filter((arg) => arg === '--instance' || arg.startsWith('--instance=')).length > 1) {
    throw commandUsageError(command, 'Provide --instance at most once.');
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      instance: { type: 'string' }, json: { type: 'boolean', default: false },
      ...(command === 'open' ? { 'no-browser': { type: 'boolean' as const, default: false } } : {}),
    } });
  } catch (error) {
    if (error instanceof TypeError) throw commandUsageError(command, argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    throw commandUsageError(command, 'Provide a drop name and an optional file or directory path.');
  }
  return { target: parsed.positionals[0]!, path: parsed.positionals[1],
    instance: parsed.values.instance, json: parsed.values.json, noBrowser: parsed.values['no-browser'] === true };
}
