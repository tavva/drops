// ABOUTME: Parses browser-login instance selection and invokes authentication orchestration.
// ABOUTME: Keeps interactive progress and the resolved instance behind callbacks.
import { login, type AuthDependencies, type AuthorizeUrlReporter } from '../auth.js';
import { parseInstanceArguments, type ParsedInstanceArguments } from './instanceArguments.js';

export type ParsedLoginArguments = ParsedInstanceArguments;

export function parseLoginArguments(argv: string[]): ParsedLoginArguments {
  return parseInstanceArguments('login', argv);
}

export async function runLoginCommand(
  options: ParsedLoginArguments & {
    cwd: string;
    onBrowserOpen: () => void;
    onAuthorizeUrl: AuthorizeUrlReporter;
    onConfiguredInstance: (origin: string, configPath: string) => void;
  },
  dependencies?: AuthDependencies,
) {
  return login({
    cwd: options.cwd,
    instance: options.instance,
    onBrowserOpen: options.onBrowserOpen,
    onAuthorizeUrl: options.onAuthorizeUrl,
    onConfiguredInstance: options.onConfiguredInstance,
  }, dependencies);
}
