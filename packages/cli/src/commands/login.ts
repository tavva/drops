// ABOUTME: Parses the exact browser-login command and invokes authentication orchestration.
// ABOUTME: Requires one explicit origin and keeps interactive progress behind a callback.
import { parseArgs } from 'node:util';

import { login, type AuthDependencies, type AuthorizeUrlReporter } from '../auth.js';
import { argumentErrorMessage, commandUsageError } from '../help.js';

export interface ParsedLoginArguments {
  origin: string;
  json: boolean;
}

export function parseLoginArguments(argv: string[]): ParsedLoginArguments {
  const jsonOccurrences = argv.filter((argument) => argument === '--json').length;
  if (jsonOccurrences > 1) throw commandUsageError('login', 'Provide --json at most once.');
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof TypeError) throw commandUsageError('login', argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length !== 1) throw commandUsageError('login', 'Provide exactly one instance origin.');
  return { origin: parsed.positionals[0]!, json: parsed.values.json };
}

export async function runLoginCommand(
  options: ParsedLoginArguments & { onBrowserOpen: () => void; onAuthorizeUrl: AuthorizeUrlReporter },
  dependencies?: AuthDependencies,
) {
  return login({
    origin: options.origin,
    onBrowserOpen: options.onBrowserOpen,
    onAuthorizeUrl: options.onAuthorizeUrl,
  }, dependencies);
}
