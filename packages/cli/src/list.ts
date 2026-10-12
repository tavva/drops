// ABOUTME: Orchestrates authenticated drop listing across instance resolution and the list APIs.
// ABOUTME: Keeps credentials origin-bound and validates drop references before any network request.
import {
  DropsApiClient,
  type DropsFilesResult,
  type DropsListResult,
  type DropsReadFilesResult,
} from './api.js';
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
  listDropFiles(origin: string, token: string, name: string): Promise<DropsFilesResult>;
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
): Promise<DropsListResult | DropsFilesResult> {
  const reference = options.name === undefined
    ? undefined
    : parseDropReference(options.name, 'drops list design-preview');
  const { origin, token } = await authenticatedInstance(options, dependencies, 'listing drops');
  if (reference === undefined) return dependencies.api.listDrops(origin, token, { all: options.all === true });
  if (reference.owner === undefined) return dependencies.api.listDropFiles(origin, token, reference.name);
  return dependencies.api.readDropFiles(origin, token, reference.owner, reference.name);
}
