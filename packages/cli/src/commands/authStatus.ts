// ABOUTME: Parses auth-status instance selection and invokes identity validation with stale-token cleanup.
// ABOUTME: Allows repository configuration only when no positional or flag origin is supplied.
import { authStatus, type AuthDependencies } from '../auth.js';
import { parseInstanceArguments, type ParsedInstanceArguments } from './instanceArguments.js';

export type ParsedAuthStatusArguments = ParsedInstanceArguments;

export function parseAuthStatusArguments(argv: string[]): ParsedAuthStatusArguments {
  return parseInstanceArguments('auth status', argv);
}

export async function runAuthStatusCommand(
  options: ParsedAuthStatusArguments & { cwd: string },
  dependencies?: AuthDependencies,
) {
  return authStatus({ cwd: options.cwd, instance: options.instance }, dependencies);
}
