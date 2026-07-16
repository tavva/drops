// ABOUTME: Orchestrates authenticated drop listing across instance resolution and the list APIs.
// ABOUTME: Keeps credentials origin-bound and validates drop names before any network request.
import { DropsApiClient, type DropsFilesResult, type DropsListResult } from './api.js';
import { DROP_SLUG } from './deploy.js';
import { invalidDropNameError, notAuthenticatedError } from './errors.js';
import { resolveInstance } from './instance.js';
import { MacOsKeychainStore, type CredentialStore } from './keychain.js';

export interface ListOptions {
  cwd: string;
  name?: string;
  instance?: string;
}

export interface ListApi {
  listDrops(origin: string, token: string): Promise<DropsListResult>;
  listDropFiles(origin: string, token: string, name: string): Promise<DropsFilesResult>;
}

export interface ListDependencies {
  api: ListApi;
  store: Pick<CredentialStore, 'get'>;
  resolveInstance?: typeof resolveInstance;
}

export function createListDependencies(): ListDependencies {
  return { api: new DropsApiClient(), store: new MacOsKeychainStore(), resolveInstance };
}

export async function list(
  options: ListOptions,
  dependencies: ListDependencies = createListDependencies(),
): Promise<DropsListResult | DropsFilesResult> {
  if (options.name !== undefined && !DROP_SLUG.test(options.name)) {
    throw invalidDropNameError(options.name, 'drops list design-preview');
  }
  const origin = await (dependencies.resolveInstance ?? resolveInstance)({
    cwd: options.cwd,
    explicit: options.instance,
  });
  const token = await dependencies.store.get(origin);
  if (token === null) throw notAuthenticatedError(origin, 'listing drops');
  if (options.name === undefined) return dependencies.api.listDrops(origin, token);
  return dependencies.api.listDropFiles(origin, token, options.name);
}
