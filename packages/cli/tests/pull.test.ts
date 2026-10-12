// ABOUTME: Verifies pull path validation, atomic downloads, restart-once, cleanup, and output.
// ABOUTME: Uses injected API fakes and real temporary directories; no credential store or network is touched.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DropsReadFilesResult } from '../src/api.js';
import { parsePullArguments } from '../src/commands/pull.js';
import { DropsCliError } from '../src/errors.js';
import { runCli } from '../src/index.js';
import { isSafeRelativePath, pull, type PullDependencies } from '../src/pull.js';

const ORIGIN = 'https://drops.example.com';

async function* content(...values: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
  for (const value of values) yield typeof value === 'string' ? Buffer.from(value) : value;
}

function dependencies(overrides: Partial<PullDependencies['api']> = {}): PullDependencies {
  return {
    api: {
      whoami: vi.fn().mockResolvedValue({ id: 'user-1', email: 'alice@example.com', username: 'alice' }),
      readDropFiles: vi.fn<() => Promise<DropsReadFilesResult>>(),
      readDropFile: vi.fn().mockImplementation(async () => content('hello')),
      ...overrides,
    },
    store: { get: vi.fn().mockResolvedValue('secret-token') },
    resolveInstance: vi.fn().mockResolvedValue(ORIGIN),
  };
}

async function invoke(argv: string[], deps: PullDependencies, cwd: string) {
  const capture = { stdout: '', stderr: '' };
  const exitCode = await runCli(argv, {
    cwd,
    stdout: { write: (value: string) => (capture.stdout += value) },
    stderr: { write: (value: string) => (capture.stderr += value) },
  }, undefined, { pull: deps });
  return { ...capture, exitCode };
}

describe('isSafeRelativePath', () => {
  it.each(['index.html', 'assets/app.js', 'a b/c#d?.txt', 'ünïcode/ファイル.txt'])('accepts %s', (path) => {
    expect(isSafeRelativePath(path)).toBe(true);
  });

  it.each([
    '', '/etc/passwd', '../secret', 'a/../../b', './index.html', 'a/./b', 'a//b', 'a/', 'a\\b',
    'line\nbreak', 'nul\u0000byte', '..', '.env', 'a/.git/config',
  ])('rejects %j', (path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });
});

describe('pull', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'drops-pull-test-'));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const listing: DropsReadFilesResult = {
    instance: ORIGIN,
    owner: 'bob',
    name: 'site',
    versionId: 'version-1',
    files: [
      { path: 'index.html', size: 5 },
      { path: 'assets/deep/app.js', size: 3 },
      { path: 'image.bin', size: 3 },
    ],
  };

  const bodies: Record<string, Array<string | Uint8Array>> = {
    'index.html': ['<h1>', '!'],
    'assets/deep/app.js': ['1;\n'],
    'image.bin': [new Uint8Array([0, 255, 10])],
  };

  function pullDependencies(overrides: Partial<PullDependencies['api']> = {}): PullDependencies {
    return dependencies({
      readDropFiles: vi.fn().mockResolvedValue(listing),
      readDropFile: vi.fn().mockImplementation(async (_origin: string, _token: string, options: { path: string }) =>
        content(...bodies[options.path]!)),
      ...overrides,
    });
  }

  it('downloads every file into the target directory and reports the result', async () => {
    const deps = pullDependencies();
    const result = await pull({ cwd: parent, reference: 'bob/site', directory: 'out' }, deps);
    const directory = join(parent, 'out');
    expect(result).toEqual({
      instance: ORIGIN,
      owner: 'bob',
      name: 'site',
      versionId: 'version-1',
      directory,
      fileCount: 3,
      byteSize: 11,
    });
    expect(await readFile(join(directory, 'index.html'), 'utf8')).toBe('<h1>!');
    expect(await readFile(join(directory, 'assets/deep/app.js'), 'utf8')).toBe('1;\n');
    expect(await readFile(join(directory, 'image.bin'))).toEqual(Buffer.from([0, 255, 10]));
    expect(await readdir(parent)).toEqual(['out']);
    expect(deps.api.readDropFile).toHaveBeenCalledWith(ORIGIN, 'secret-token', {
      owner: 'bob', name: 'site', path: 'image.bin', versionId: 'version-1',
    });
    expect(deps.api.whoami).not.toHaveBeenCalled();
  });

  it('defaults the directory to the drop name and resolves a bare name to the caller', async () => {
    const deps = pullDependencies();
    const result = await pull({ cwd: parent, reference: 'site' }, deps);
    expect(result.directory).toBe(join(parent, 'site'));
    expect(deps.api.readDropFiles).toHaveBeenCalledWith(ORIGIN, 'secret-token', 'alice', 'site');
  });

  it('fills an existing empty directory and creates missing parents', async () => {
    await mkdir(join(parent, 'empty'));
    await pull({ cwd: parent, reference: 'bob/site', directory: 'empty' }, pullDependencies());
    expect(await readdir(join(parent, 'empty'))).toHaveLength(3);
    await pull({ cwd: parent, reference: 'bob/site', directory: 'a/b/c' }, pullDependencies());
    expect(await readdir(join(parent, 'a/b/c'))).toHaveLength(3);
  });

  it('creates an empty directory for a drop without a current version', async () => {
    const deps = pullDependencies({
      readDropFiles: vi.fn().mockResolvedValue({ ...listing, versionId: null, files: [] }),
    });
    const result = await pull({ cwd: parent, reference: 'bob/site' }, deps);
    expect(result).toMatchObject({ versionId: null, fileCount: 0, byteSize: 0 });
    expect(await readdir(join(parent, 'site'))).toEqual([]);
  });

  it.each([
    ['a non-empty directory', async (target: string) => {
      await mkdir(target);
      await writeFile(join(target, 'keep.txt'), 'keep');
    }],
    ['a file', async (target: string) => writeFile(target, 'keep')],
  ])('refuses %s before any network request', async (_label, prepare) => {
    const target = join(parent, 'site');
    await prepare(target);
    const deps = pullDependencies();
    await expect(pull({ cwd: parent, reference: 'bob/site' }, deps)).rejects.toMatchObject({
      code: 'directory_not_empty',
      details: { directory: target },
      exitCode: 2,
    });
    expect(deps.resolveInstance).not.toHaveBeenCalled();
  });

  it.each(['../escape.txt', '/etc/passwd', 'a/../../escape.txt', 'a//b'])(
    'rejects the hostile server path %j without writing anything',
    async (path) => {
      const deps = pullDependencies({
        readDropFiles: vi.fn().mockResolvedValue({ ...listing, files: [{ path: 'index.html', size: 5 }, { path, size: 1 }] }),
      });
      await expect(pull({ cwd: parent, reference: 'bob/site' }, deps)).rejects.toMatchObject({
        code: 'unsafe_path',
        details: { path },
        instance: ORIGIN,
        exitCode: 6,
      });
      expect(deps.api.readDropFile).not.toHaveBeenCalled();
      expect(await readdir(parent)).toEqual([]);
    },
  );

  it.each([[['a', 'a/b']], [['a/b', 'a']]])('reports clashing paths %j as a path conflict', async (paths) => {
    const deps = pullDependencies({
      readDropFiles: vi.fn().mockResolvedValue({ ...listing, files: paths.map((path) => ({ path, size: 1 })) }),
      readDropFile: vi.fn().mockImplementation(async () => content('x')),
    });
    await expect(pull({ cwd: parent, reference: 'bob/site' }, deps)).rejects.toMatchObject({
      code: 'path_conflict',
      details: { path: paths[1] },
      instance: ORIGIN,
      exitCode: 6,
    });
    expect(await readdir(parent)).toEqual([]);
  });

  it('reports a local write failure with the path and errno', async () => {
    const { chmod } = await import('node:fs/promises');
    const locked = join(parent, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      await expect(pull({ cwd: parent, reference: 'bob/site', directory: 'locked/out' }, pullDependencies()))
        .rejects.toMatchObject({
          code: 'write_failed',
          details: { path: join(locked, 'out'), errno: 'EACCES' },
          exitCode: 6,
        });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('refuses a destination whose parent is a file', async () => {
    await writeFile(join(parent, 'file'), 'x');
    await expect(pull({ cwd: parent, reference: 'bob/site', directory: 'file/out' }, pullDependencies()))
      .rejects.toMatchObject({ code: 'write_failed', details: { errno: 'ENOTDIR' }, exitCode: 6 });
  });

  it('restarts once when the drop changes during the pull', async () => {
    let calls = 0;
    const readDropFile = vi.fn().mockImplementation(async (_origin: string, _token: string, options: { path: string }) => {
      calls += 1;
      if (calls === 2) {
        throw new DropsCliError({ code: 'version_changed', message: 'changed', instance: ORIGIN, exitCode: 4 });
      }
      return content(...bodies[options.path]!);
    });
    const readDropFiles = vi.fn()
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce({ ...listing, versionId: 'version-2' });
    const deps = pullDependencies({ readDropFile, readDropFiles });

    const result = await pull({ cwd: parent, reference: 'bob/site' }, deps);
    expect(result.versionId).toBe('version-2');
    expect(readDropFiles).toHaveBeenCalledTimes(2);
    expect(readDropFile).toHaveBeenLastCalledWith(ORIGIN, 'secret-token', {
      owner: 'bob', name: 'site', path: 'image.bin', versionId: 'version-2',
    });
    expect(await readdir(parent)).toEqual(['site']);
    expect(await readdir(join(parent, 'site'))).toHaveLength(3);
  });

  it('fails and cleans up when the drop changes twice', async () => {
    const deps = pullDependencies({
      readDropFile: vi.fn().mockRejectedValue(
        new DropsCliError({ code: 'version_changed', message: 'changed', instance: ORIGIN, exitCode: 4 }),
      ),
    });
    await expect(pull({ cwd: parent, reference: 'bob/site' }, deps)).rejects.toMatchObject({ code: 'version_changed' });
    expect(deps.api.readDropFiles).toHaveBeenCalledTimes(2);
    expect(await readdir(parent)).toEqual([]);
  });

  it('removes the partial download when a file fails mid-pull', async () => {
    let calls = 0;
    const deps = pullDependencies({
      readDropFile: vi.fn().mockImplementation(async (_origin: string, _token: string, options: { path: string }) => {
        calls += 1;
        if (calls === 3) throw new DropsCliError({ code: 'network_error', message: 'down', instance: ORIGIN, exitCode: 5 });
        return content(...bodies[options.path]!);
      }),
    });
    await expect(pull({ cwd: parent, reference: 'bob/site' }, deps)).rejects.toMatchObject({ code: 'network_error' });
    expect(await readdir(parent)).toEqual([]);
  });

  it('registers the staging directory for interrupt cleanup and unregisters it afterwards', async () => {
    const cleanups: Array<() => Promise<void>> = [];
    const unregister = vi.fn();
    const deps = {
      ...pullDependencies(),
      registerCleanup: vi.fn((cleanup: () => Promise<void>) => {
        cleanups.push(cleanup);
        return unregister;
      }),
    };
    await pull({ cwd: parent, reference: 'bob/site' }, deps);
    expect(cleanups).toHaveLength(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});

describe('parsePullArguments', () => {
  it('parses a reference, an optional directory and flags', () => {
    expect(parsePullArguments(['bob/site'])).toEqual({ reference: 'bob/site', json: false });
    expect(parsePullArguments(['bob/site', './out', '--instance', ORIGIN, '--json'])).toEqual({
      reference: 'bob/site', directory: './out', instance: ORIGIN, json: true,
    });
  });

  it.each([[[]], [['site', 'a', 'b']]])('requires a reference and at most one directory: %j', (argv) => {
    expect(() => parsePullArguments(argv)).toThrow(expect.objectContaining({ code: 'usage_error', exitCode: 2 }));
  });
});

describe('pull dispatch', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'drops-pull-dispatch-'));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function deps() {
    return dependencies({
      readDropFiles: vi.fn().mockResolvedValue({
        instance: ORIGIN, owner: 'bob', name: 'site', versionId: 'version-1', files: [{ path: 'index.html', size: 1536 }],
      }),
      readDropFile: vi.fn().mockImplementation(async () => content(Buffer.alloc(1536, 'x'))),
    });
  }

  it('prints one JSON result', async () => {
    const result = await invoke(['pull', 'bob/site', '--json'], deps(), parent);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      instance: ORIGIN,
      owner: 'bob',
      name: 'site',
      versionId: 'version-1',
      directory: join(parent, 'site'),
      fileCount: 1,
      byteSize: 1536,
    });
  });

  it('prints one summary line for humans', async () => {
    const result = await invoke(['pull', 'bob/site', 'out'], deps(), parent);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Pulled bob/site (1 file, 1.5 KB) to ${join(parent, 'out')}\n`);
  });
});
