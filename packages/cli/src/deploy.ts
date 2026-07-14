// ABOUTME: Orchestrates authenticated CLI deployments across instance resolution, packaging, and upload.
// ABOUTME: Keeps credentials origin-bound, streams archives with progress, and always removes generated files.
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { DropsApiClient, type DropsDeploymentResult } from './api.js';
import { DropsCliError } from './errors.js';
import { resolveInstance } from './instance.js';
import { MacOsKeychainStore, type CredentialStore } from './keychain.js';
import type { LifecycleRegistrar } from './lifecycle.js';
import { packageSource, type PackagedSource, type PackageSourceOptions } from './packageSource.js';

const DROP_SLUG = /^(?!.*--)[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/u;

function warn(callback: DeployOptions['onWarning'], message: string): void {
  try {
    callback?.(message);
  } catch {
    // Diagnostics are best-effort and must not replace the deployment outcome.
  }
}

export interface DeployOptions {
  cwd: string;
  path: string;
  name: string;
  instance?: string;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  onWarning?: (message: string) => void;
}

export interface DeployApi {
  discover(origin: string): Promise<unknown>;
  deployZip(options: Parameters<DropsApiClient['deployZip']>[0]): Promise<DropsDeploymentResult>;
}

export interface DeployDependencies {
  api: DeployApi;
  store: Pick<CredentialStore, 'get'>;
  packageSource(path: string, options?: PackageSourceOptions): Promise<PackagedSource>;
  createReadStream(path: string): Readable;
  resolveInstance?: typeof resolveInstance;
  registerCleanup?: LifecycleRegistrar;
}

export function createDeployDependencies(registerCleanup?: LifecycleRegistrar): DeployDependencies {
  return {
    api: new DropsApiClient(),
    store: new MacOsKeychainStore(),
    packageSource,
    createReadStream,
    resolveInstance,
    registerCleanup,
  };
}

export async function deploy(
  options: DeployOptions,
  dependencies: DeployDependencies = createDeployDependencies(),
): Promise<DropsDeploymentResult> {
  if (!DROP_SLUG.test(options.name)) {
    throw new DropsCliError({
      code: 'invalid_name',
      message: 'The drop name must be a valid slug',
      details: { name: options.name },
      guidance: {
        hint: 'Use lowercase letters, numbers, and single hyphens; names must start and end with a letter or number.',
        examples: ['drops deploy ./dist --name design-preview'],
      },
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
      message: `This Mac is not authenticated to ${origin}.`,
      instance: origin,
      guidance: {
        hint: 'Authenticate this exact instance before deploying.',
        examples: [`drops login ${origin}`],
      },
      exitCode: 3,
    });
  }

  await dependencies.api.discover(origin);
  const packaged = await dependencies.packageSource(options.path, {
    registerCleanup: dependencies.registerCleanup,
    onCleanupWarning: options.onWarning,
  });
  let body: Readable | undefined;
  let remoteAttempted = false;
  let result: DropsDeploymentResult | undefined;
  let failure: unknown;
  try {
    body = dependencies.createReadStream(packaged.path);
    remoteAttempted = true;
    result = await dependencies.api.deployZip({
      origin,
      token,
      name: options.name,
      body,
      contentLength: packaged.byteSize,
      onProgress: options.onProgress,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (body !== undefined) {
      if (!body.destroyed) body.destroy();
      await finished(body).catch(() => {});
    }
    try {
      await packaged.cleanup();
    } catch (cleanupError) {
      warn(options.onWarning, 'Could not remove the temporary deployment archive');
      if (!remoteAttempted && failure === undefined) failure = cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
  return result!;
}
