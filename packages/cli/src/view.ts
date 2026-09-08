// ABOUTME: Reads existing drops and opens authenticated drop pages with origin-bound CLI credentials.
// ABOUTME: Validates targets before credential lookup and exposes browser handoffs for headless use.
import { DropsApiClient, type DropsViewTarget } from './api.js';
import { openSystemBrowser, type BrowserOpener } from './auth.js';
import { createCredentialStore } from './credentials.js';
import { DROP_SLUG } from './deploy.js';
import { DropsCliError, notAuthenticatedError } from './errors.js';
import { commandUsageError } from './help.js';
import { resolveInstance } from './instance.js';
import type { CredentialStore } from './keychain.js';

export interface ViewOptions {
  cwd: string;
  target: string;
  path?: string;
  instance?: string;
  json: boolean;
  noBrowser?: boolean;
}

export interface ViewDependencies {
  api: Pick<DropsApiClient, 'viewDrop' | 'openDrop'>;
  store: Pick<CredentialStore, 'get'>;
  resolveInstance?: typeof resolveInstance;
  openBrowser: BrowserOpener;
}

export function createViewDependencies(): ViewDependencies {
  return { api: new DropsApiClient(), store: createCredentialStore(), resolveInstance, openBrowser: openSystemBrowser };
}

function parseTarget(options: ViewOptions, command: 'view' | 'open'): DropsViewTarget {
  const parts = options.target.split('/');
  if (parts.length > 2 || parts.some((part) => !DROP_SLUG.test(part))) {
    throw commandUsageError(command, 'Provide a drop name or owner/name.');
  }
  const path = (options.path ?? '').normalize('NFC');
  const segments = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/');
  if (path !== '' && (/[\\\x00-\x1f\x7f]/u.test(path) || /^[A-Za-z]:/u.test(path) ||
    segments.some((segment) => !segment || segment.startsWith('.')))) {
    throw commandUsageError(command, 'Provide a relative file or directory path without dot segments.');
  }
  return { name: parts.at(-1)!, ...(parts.length === 2 ? { owner: parts[0]! } : {}), path };
}

async function authorise(options: ViewOptions, command: 'view' | 'open', dependencies: ViewDependencies) {
  const target = parseTarget(options, command);
  const origin = await (dependencies.resolveInstance ?? resolveInstance)({ cwd: options.cwd, explicit: options.instance });
  const token = await dependencies.store.get(origin);
  if (token === null) throw notAuthenticatedError(origin, 'viewing drops');
  return { target, origin, token };
}

export async function view(options: ViewOptions, dependencies = createViewDependencies()) {
  const { target, origin, token } = await authorise(options, 'view', dependencies);
  const result = await dependencies.api.viewDrop(origin, token, target);
  if (!options.json && result.encoding === 'base64') {
    throw new DropsCliError({ code: 'binary_file', message: 'This file is binary. Use --json for base64 content or drops open to view it in a browser.', instance: origin, exitCode: 4 });
  }
  return result;
}

export async function open(
  options: ViewOptions,
  diagnostic: (message: string) => void,
  dependencies = createViewDependencies(),
) {
  const { target, origin, token } = await authorise(options, 'open', dependencies);
  const result = await dependencies.api.openDrop(origin, token, target);
  if (!options.json) diagnostic(`Open this private URL within ${result.expiresIn} seconds:\n${result.openUrl}`);
  if (!options.noBrowser) {
    try { await dependencies.openBrowser(result.openUrl); }
    catch { diagnostic('Could not open the browser. Open the private URL manually.'); }
  }
  return result;
}
