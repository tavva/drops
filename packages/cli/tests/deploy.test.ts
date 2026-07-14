// ABOUTME: Verifies deploy orchestration, command parsing, output isolation, and cleanup guarantees.
// ABOUTME: Covers instance precedence, explicit names, authentication, discovery, progress, and errors.
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { DropsDeploymentResult } from '../src/api.js';
import { parseDeployArguments } from '../src/commands/deploy.js';
import { deploy, type DeployDependencies } from '../src/deploy.js';
import { DropsCliError } from '../src/errors.js';
import { runCli } from '../src/index.js';

const result: DropsDeploymentResult = {
  instance: 'https://drops.example.com',
  name: 'sample-site',
  url: 'https://alice--sample-site.content.example.com',
  versionId: 'version-1',
  fileCount: 2,
  byteSize: 8,
  entryPath: 'index.html',
};

function dependencies(overrides: Partial<DeployDependencies> = {}) {
  const cleanup = vi.fn(async () => {});
  const api = {
    discover: vi.fn(async (origin: string) => ({ service: 'drops' as const, apiVersion: 1 as const, appOrigin: origin })),
    deployZip: vi.fn(async () => result),
  };
  const store = { get: vi.fn(async () => 'drops_cli_secret') };
  const packageLocalSource = vi.fn(async () => ({ path: '/tmp/upload.zip', byteSize: 8, cleanup }));
  const createBody = vi.fn(() => Readable.from([Buffer.from('zip-body')]));
  const deps: DeployDependencies = { api, store, packageSource: packageLocalSource, createReadStream: createBody, ...overrides };
  return { deps, api, store, packageLocalSource, createBody, cleanup };
}

describe('parseDeployArguments', () => {
  it('accepts exactly drops deploy <path> --name <name> with optional instance and JSON', () => {
    expect(parseDeployArguments(['dist', '--name', 'sample-site', '--instance', 'https://drops.example.com', '--json']))
      .toEqual({ path: 'dist', name: 'sample-site', instance: 'https://drops.example.com', json: true });
  });

  it.each([
    [[], 'Provide one source path and the required --name.'],
    [['one', 'two', '--name', 'sample'], 'exactly one source path'],
    [['dist'], '--name'],
    [['dist', '--name', 'one', '--name', 'two'], '--name'],
    [['dist', '--name', 'one', '--instance', 'https://one.example.com', '--instance', 'https://two.example.com'], '--instance'],
  ])('rejects invalid deploy arguments %#', (argv, message) => {
    expect(() => parseDeployArguments(argv)).toThrow(expect.objectContaining({ exitCode: 2, message: expect.stringContaining(message) }));
  });
});

describe('deploy', () => {
  it('requires a valid explicit slug before instance resolution or packaging', async () => {
    const setup = dependencies();

    await expect(deploy({ cwd: '/repo', path: 'dist', name: 'Bad Name' }, setup.deps)).rejects.toMatchObject({
      code: 'invalid_name',
      exitCode: 2,
    });
    expect(setup.store.get).not.toHaveBeenCalled();
    expect(setup.packageLocalSource).not.toHaveBeenCalled();
  });

  it('resolves repository instance, loads its exact credential, discovers, packages, and streams with progress', async () => {
    const registerCleanup = vi.fn(() => () => {});
    const setup = dependencies({
      resolveInstance: vi.fn(async () => 'https://drops.example.com'),
      registerCleanup,
    });
    const progress = vi.fn();
    setup.api.deployZip.mockImplementation(async (options) => {
      const chunks: Buffer[] = [];
      for await (const chunk of options.body as Readable) chunks.push(Buffer.from(chunk));
      options.onProgress?.(4, 8);
      options.onProgress?.(8, 8);
      expect(Buffer.concat(chunks).toString()).toBe('zip-body');
      return result;
    });

    await expect(deploy({ cwd: '/repo/project', path: 'dist', name: 'sample-site', onProgress: progress }, setup.deps))
      .resolves.toEqual(result);

    expect(setup.deps.resolveInstance).toHaveBeenCalledWith({ cwd: '/repo/project', explicit: undefined });
    expect(setup.store.get).toHaveBeenCalledWith('https://drops.example.com');
    expect(setup.api.discover).toHaveBeenCalledWith('https://drops.example.com');
    expect(setup.packageLocalSource).toHaveBeenCalledWith('dist', { registerCleanup });
    expect(setup.api.deployZip).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://drops.example.com',
      token: 'drops_cli_secret',
      name: 'sample-site',
      contentLength: 8,
      body: expect.any(Readable),
      onProgress: expect.any(Function),
    }));
    expect(progress.mock.calls).toEqual([[4, 8], [8, 8]]);
    expect(setup.cleanup).toHaveBeenCalledOnce();
  });

  it('uses an explicit instance override and canonical resolution seam', async () => {
    const resolveInstance = vi.fn(async () => 'https://override.example.com');
    const setup = dependencies({ resolveInstance });

    await deploy({ cwd: '/repo', path: 'dist', name: 'sample-site', instance: 'HTTPS://Override.Example.com/' }, setup.deps);

    expect(resolveInstance).toHaveBeenCalledWith({ cwd: '/repo', explicit: 'HTTPS://Override.Example.com/' });
    expect(setup.store.get).toHaveBeenCalledWith('https://override.example.com');
    expect(setup.api.discover).toHaveBeenCalledWith('https://override.example.com');
  });

  it('reports exact-origin login instructions before discovery or packaging when no token exists', async () => {
    const setup = dependencies({
      resolveInstance: vi.fn(async () => 'https://drops.example.com'),
      store: { get: vi.fn(async () => null) },
    });

    await expect(deploy({ cwd: '/repo', path: 'dist', name: 'sample-site' }, setup.deps)).rejects.toEqual(
      expect.objectContaining({
        code: 'not_authenticated',
        message: 'This Mac is not authenticated to https://drops.example.com.',
        instance: 'https://drops.example.com',
        guidance: expect.objectContaining({
          hint: 'Authenticate this exact instance before deploying.',
          examples: ['drops login https://drops.example.com'],
        }),
        exitCode: 3,
      }),
    );
    expect(setup.api.discover).not.toHaveBeenCalled();
    expect(setup.packageLocalSource).not.toHaveBeenCalled();
  });

  it.each(['discovery', 'upload'] as const)('always cleans the generated archive after a %s error', async (stage) => {
    const setup = dependencies({ resolveInstance: vi.fn(async () => 'https://drops.example.com') });
    const error = new DropsCliError({ code: 'network_error', message: 'offline', exitCode: 5 });
    if (stage === 'discovery') setup.api.discover.mockRejectedValue(error);
    else setup.api.deployZip.mockRejectedValue(error);

    await expect(deploy({ cwd: '/repo', path: 'dist', name: 'sample-site' }, setup.deps)).rejects.toBe(error);

    expect(setup.cleanup).toHaveBeenCalledTimes(stage === 'discovery' ? 0 : 1);
  });

  it('cleans the generated archive when opening its upload stream throws', async () => {
    const setup = dependencies({
      resolveInstance: vi.fn(async () => 'https://drops.example.com'),
      createReadStream: vi.fn(() => {
        throw new Error('open failed');
      }),
    });

    await expect(deploy({ cwd: '/repo', path: 'dist', name: 'sample-site' }, setup.deps)).rejects.toThrow(
      'open failed',
    );

    expect(setup.api.deployZip).not.toHaveBeenCalled();
    expect(setup.cleanup).toHaveBeenCalledOnce();
  });

  it('preserves a successful remote result and warns when archive cleanup fails', async () => {
    const onWarning = vi.fn();
    const setup = dependencies({ resolveInstance: vi.fn(async () => 'https://drops.example.com') });
    setup.cleanup.mockRejectedValue(new Error('secret cleanup detail'));

    await expect(deploy({ cwd: '/repo', path: 'dist', name: 'sample-site', onWarning }, setup.deps))
      .resolves.toEqual(result);

    expect(onWarning).toHaveBeenCalledWith('Could not remove the temporary deployment archive');
    expect(JSON.stringify(onWarning.mock.calls)).not.toContain('secret cleanup detail');
  });

  it('preserves a successful remote result when the cleanup warning writer also throws', async () => {
    const setup = dependencies({ resolveInstance: vi.fn(async () => 'https://drops.example.com') });
    setup.cleanup.mockRejectedValue(new Error('cleanup failed'));

    await expect(deploy({
      cwd: '/repo',
      path: 'dist',
      name: 'sample-site',
      onWarning: () => { throw new Error('writer failed'); },
    }, setup.deps)).resolves.toEqual(result);
  });

  it('preserves the API error and warns when archive cleanup also fails', async () => {
    const onWarning = vi.fn();
    const setup = dependencies({ resolveInstance: vi.fn(async () => 'https://drops.example.com') });
    const apiError = new DropsCliError({ code: 'network_error', message: 'offline', exitCode: 5 });
    setup.api.deployZip.mockRejectedValue(apiError);
    setup.cleanup.mockRejectedValue(new Error('cleanup failed'));

    await expect(deploy({ cwd: '/repo', path: 'dist', name: 'sample-site', onWarning }, setup.deps))
      .rejects.toBe(apiError);
    expect(onWarning).toHaveBeenCalledOnce();
  });
});

describe('deploy CLI output', () => {
  function capture() {
    let stdout = '';
    let stderr = '';
    return {
      runtime: {
        cwd: '/repo',
        stdout: { write: (chunk: string) => { stdout += chunk; } },
        stderr: { write: (chunk: string) => { stderr += chunk; } },
      },
      output: () => ({ stdout, stderr }),
    };
  }

  it.each([false, true])('keeps progress on stderr and emits the exact %s result', async (json) => {
    const captured = capture();
    const setup = dependencies({ resolveInstance: vi.fn(async () => 'https://drops.example.com') });
    setup.api.deployZip.mockImplementation(async (options) => {
      options.onProgress?.(8, 8);
      return result;
    });

    const exitCode = await runCli(
      ['deploy', 'dist', '--name', 'sample-site', ...(json ? ['--json'] : [])],
      captured.runtime,
      undefined,
      { deploy: setup.deps },
    );

    expect(exitCode).toBe(0);
    expect(captured.output().stdout).toBe(json ? `${JSON.stringify(result)}\n` : `${result.url}\n`);
    expect(captured.output().stderr).toContain('Uploading');
    expect(captured.output().stderr).not.toContain('drops_cli_secret');
  });

  it('keeps a cleanup warning on stderr while JSON stdout contains only the successful result', async () => {
    const captured = capture();
    const setup = dependencies({ resolveInstance: vi.fn(async () => 'https://drops.example.com') });
    setup.cleanup.mockRejectedValue(new Error('cleanup failed'));

    const exitCode = await runCli(
      ['deploy', 'dist', '--name', 'sample-site', '--json'],
      captured.runtime,
      undefined,
      { deploy: setup.deps },
    );

    expect(exitCode).toBe(0);
    expect(captured.output().stdout).toBe(`${JSON.stringify(result)}\n`);
    expect(captured.output().stderr).toBe('Could not remove the temporary deployment archive\n');
  });
});
