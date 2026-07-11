// ABOUTME: Orchestrates authenticated CLI deployments across instance resolution, packaging, and upload.
// ABOUTME: Keeps credentials origin-bound, streams archives with progress, and always removes generated files.
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { DropsApiClient, type DropsDeploymentResult } from './api.js';
import { DropsCliError } from './errors.js';
import { resolveInstance } from './instance.js';
import { MacOsKeychainStore, type CredentialStore } from './keychain.js';
import { packageSource, type PackagedSource } from './packageSource.js';

const DROP_SLUG = /^(?!.*--)[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/u;

export interface DeployOptions {
  cwd: string;
  path: string;
  name: string;
  instance?: string;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface DeployApi {
  discover(origin: string): Promise<unknown>;
  deployZip(options: Parameters<DropsApiClient['deployZip']>[0]): Promise<DropsDeploymentResult>;
}

export interface DeployDependencies {
  api: DeployApi;
  store: Pick<CredentialStore, 'get'>;
  packageSource(path: string): Promise<PackagedSource>;
  createReadStream(path: string): Readable;
  resolveInstance?: typeof resolveInstance;
}

function defaultDependencies(): DeployDependencies {
  return {
    api: new DropsApiClient(),
    store: new MacOsKeychainStore(),
    packageSource,
    createReadStream,
    resolveInstance,
  };
}

export async function deploy(
  options: DeployOptions,
  dependencies: DeployDependencies = defaultDependencies(),
): Promise<DropsDeploymentResult> {
  if (!DROP_SLUG.test(options.name)) {
    throw new DropsCliError({
      code: 'invalid_name',
      message: 'The drop name must be a valid slug',
      details: { name: options.name },
      exitCode: 2,
    });
  }

  const origin = await (dependencies.resolveInstance ?? resolveInstance)({
    cwd: options.cwd,
    explicit: options.instance,
  });
  const token = await dependencies.store.get(origin);
  if (token === null) {
    throw new DropsCliError({
      code: 'not_authenticated',
      message: `Run: drops login ${origin}`,
      instance: origin,
      exitCode: 3,
    });
  }

  await dependencies.api.discover(origin);
  const packaged = await dependencies.packageSource(options.path);
  const body = dependencies.createReadStream(packaged.path);
  try {
    return await dependencies.api.deployZip({
      origin,
      token,
      name: options.name,
      body,
      contentLength: packaged.byteSize,
      onProgress: options.onProgress,
    });
  } finally {
    if (!body.destroyed) body.destroy();
    await finished(body).catch(() => {});
    await packaged.cleanup();
  }
}
