// ABOUTME: Parses logout instance selection and invokes revoke-before-delete orchestration.
// ABOUTME: Rejects ambiguous positional and flag origins before touching credentials.
import { logout, type AuthDependencies } from '../auth.js';
import { parseInstanceArguments, type ParsedInstanceArguments } from './instanceArguments.js';

export type ParsedLogoutArguments = ParsedInstanceArguments;

export function parseLogoutArguments(argv: string[]): ParsedLogoutArguments {
  return parseInstanceArguments('logout', argv);
}

export async function runLogoutCommand(
  options: ParsedLogoutArguments & { cwd: string },
  dependencies?: AuthDependencies,
) {
  return logout({ cwd: options.cwd, instance: options.instance }, dependencies);
}
