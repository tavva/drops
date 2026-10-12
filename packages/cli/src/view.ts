// ABOUTME: Reads existing drops and opens authenticated drop pages with origin-bound CLI credentials.
// ABOUTME: Validates targets before credential lookup and exposes browser handoffs for headless use.
import { DropsApiClient, type DropsViewTarget } from './api.js';
import { openSystemBrowser, type BrowserOpener } from './auth.js';
import { authenticatedInstance, createCredentialStore } from './credentials.js';
import { DropsCliError } from './errors.js';
import { commandUsageError } from './help.js';
import { isSafeRelativePath, parseDropReference, type DropReference } from './reference.js';
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
  let reference: DropReference;
  try {
    reference = parseDropReference(options.target, `drops ${command} preview`);
  } catch {
    throw commandUsageError(command, 'Provide a drop name or owner/name.');
  }
  const path = (options.path ?? '').normalize('NFC');
  // A trailing slash names a directory; the rest must be a safe file path.
  const filePath = path.endsWith('/') ? path.slice(0, -1) : path;
  if (path !== '' && (/^[A-Za-z]:/u.test(path) || !isSafeRelativePath(filePath))) {
    throw commandUsageError(command, 'Provide a relative file or directory path without dot segments.');
  }
  return { ...reference, path };
}

async function authorise(options: ViewOptions, command: 'view' | 'open', dependencies: ViewDependencies) {
  const target = parseTarget(options, command);
  const { origin, token } = await authenticatedInstance(options, dependencies, 'viewing drops');
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
