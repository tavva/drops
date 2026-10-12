// ABOUTME: Orchestrates authenticated drop listing across instance resolution and the list APIs.
// ABOUTME: Keeps credentials origin-bound and validates drop references before any network request.
import { DropsApiClient, type DropsListResult, type DropsReadFilesResult, type DropsUser } from './api.js';
import { authenticatedInstance, createCredentialStore, type CredentialDependencies } from './credentials.js';
import { resolveInstance } from './instance.js';
import { parseDropReference } from './reference.js';

export interface ListOptions {
  cwd: string;
  name?: string;
  all?: boolean;
  instance?: string;
}

export interface ListApi {
  listDrops(origin: string, token: string, options: { all: boolean }): Promise<DropsListResult>;
  whoami(origin: string, token: string): Promise<DropsUser>;
  readDropFiles(origin: string, token: string, owner: string, name: string): Promise<DropsReadFilesResult>;
}

export interface ListDependencies extends CredentialDependencies {
  api: ListApi;
}

export function createListDependencies(): ListDependencies {
  return { api: new DropsApiClient(), store: createCredentialStore(), resolveInstance };
}

export async function list(
  options: ListOptions,
  dependencies: ListDependencies = createListDependencies(),
): Promise<DropsListResult | DropsReadFilesResult> {
  const reference = options.name === undefined
    ? undefined
    : parseDropReference(options.name, 'drops list design-preview');
  const { origin, token } = await authenticatedInstance(options, dependencies, 'listing drops');
  if (reference === undefined) return dependencies.api.listDrops(origin, token, { all: options.all === true });
  const owner = reference.owner ?? (await dependencies.api.whoami(origin, token)).username;
  return dependencies.api.readDropFiles(origin, token, owner, reference.name);
}
