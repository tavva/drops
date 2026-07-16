// ABOUTME: Verifies list argument parsing, orchestration credential handling, and human rendering.
// ABOUTME: Uses injected fakes so no keychain, network, or repository configuration is touched.
import { describe, expect, it, vi } from 'vitest';

import type { DropsFilesResult, DropsListResult } from '../src/api.js';
import {
  formatByteSize,
  parseListArguments,
  renderDropFiles,
  renderDropsList,
} from '../src/commands/list.js';
import { runCli } from '../src/index.js';
import { list, type ListDependencies } from '../src/list.js';

const ORIGIN = 'https://drops.example.com';

const listResult: DropsListResult = {
  instance: ORIGIN,
  drops: [
    {
      name: 'site',
      url: 'https://alice--site.content.example.com',
      updatedAt: '2026-07-16T09:00:00.000Z',
      byteSize: 1536,
      fileCount: 2,
      entryPath: 'index.html',
      versionId: 'version-1',
    },
    {
      name: 'notes',
      url: 'https://alice--notes.content.example.com',
      updatedAt: '2026-07-10T09:00:00.000Z',
      byteSize: 512,
      fileCount: 1,
      entryPath: null,
      versionId: 'version-2',
    },
  ],
};

const filesResult: DropsFilesResult = {
  instance: ORIGIN,
  name: 'site',
  files: [
    { path: 'index.html', size: 1024 },
    { path: 'assets/app.js', size: 512 },
  ],
};

function dependencies(overrides: Partial<ListDependencies> = {}): ListDependencies {
  return {
    api: {
      listDrops: vi.fn().mockResolvedValue(listResult),
      listDropFiles: vi.fn().mockResolvedValue(filesResult),
    },
    store: { get: vi.fn().mockResolvedValue('secret-token') },
    resolveInstance: vi.fn().mockResolvedValue(ORIGIN),
    ...overrides,
  };
}

describe('parseListArguments', () => {
  it('parses a bare invocation', () => {
    expect(parseListArguments([])).toEqual({ json: false });
  });

  it('captures one positional drop name and flags', () => {
    expect(parseListArguments(['site', '--instance', ORIGIN, '--json'])).toEqual({
      name: 'site',
      instance: ORIGIN,
      json: true,
    });
  });

  it('rejects more than one positional', () => {
    expect(() => parseListArguments(['one', 'two'])).toThrow(expect.objectContaining({ code: 'usage_error', exitCode: 2 }));
  });

  it('rejects duplicate --instance flags', () => {
    expect(() => parseListArguments(['--instance', ORIGIN, '--instance', ORIGIN])).toThrow(expect.objectContaining({ code: 'usage_error', exitCode: 2 }));
  });

  it('rejects unknown options', () => {
    expect(() => parseListArguments(['--unknown'])).toThrow(expect.objectContaining({ code: 'usage_error', exitCode: 2 }));
  });
});

describe('list orchestration', () => {
  it('lists drops for the resolved instance with the stored credential', async () => {
    const deps = dependencies();
    await expect(list({ cwd: '/repo' }, deps)).resolves.toEqual(listResult);
    expect(deps.resolveInstance).toHaveBeenCalledWith({ cwd: '/repo', explicit: undefined });
    expect(deps.api.listDrops).toHaveBeenCalledWith(ORIGIN, 'secret-token');
    expect(deps.api.listDropFiles).not.toHaveBeenCalled();
  });

  it('lists one drop\'s files when a name is given', async () => {
    const deps = dependencies();
    await expect(list({ cwd: '/repo', name: 'site' }, deps)).resolves.toEqual(filesResult);
    expect(deps.api.listDropFiles).toHaveBeenCalledWith(ORIGIN, 'secret-token', 'site');
    expect(deps.api.listDrops).not.toHaveBeenCalled();
  });

  it('rejects an invalid drop name before any network request', async () => {
    const deps = dependencies();
    await expect(list({ cwd: '/repo', name: 'NOT VALID' }, deps)).rejects.toMatchObject({
      code: 'invalid_name',
      exitCode: 2,
    });
    expect(deps.resolveInstance).not.toHaveBeenCalled();
  });

  it('requires an origin credential', async () => {
    const deps = dependencies({ store: { get: vi.fn().mockResolvedValue(null) } });
    await expect(list({ cwd: '/repo' }, deps)).rejects.toMatchObject({
      code: 'not_authenticated',
      instance: ORIGIN,
      exitCode: 3,
    });
    expect(deps.api.listDrops).not.toHaveBeenCalled();
  });

  it('passes an explicit --instance through to resolution', async () => {
    const deps = dependencies();
    await list({ cwd: '/repo', instance: 'https://drops.other.example' }, deps);
    expect(deps.resolveInstance).toHaveBeenCalledWith({
      cwd: '/repo',
      explicit: 'https://drops.other.example',
    });
  });
});

describe('rendering', () => {
  it('formats byte sizes', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(10 * 1024 * 1024)).toBe('10 MB');
  });

  it('renders one line per drop', () => {
    const rendered = renderDropsList(listResult);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('site');
    expect(lines[0]).toContain('https://alice--site.content.example.com');
    expect(lines[0]).toContain('2 files');
    expect(lines[0]).toContain('1.5 KB');
    expect(lines[0]).toContain('updated 2026-07-16');
    expect(lines[1]).toContain('1 file');
  });

  it('renders an empty drop list message', () => {
    expect(renderDropsList({ instance: ORIGIN, drops: [] })).toBe(`No drops on ${ORIGIN}`);
  });

  it('renders one line per file with sizes', () => {
    const rendered = renderDropFiles(filesResult);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1 KB');
    expect(lines[0]).toContain('index.html');
    expect(lines[1]).toContain('assets/app.js');
  });

  it('renders an empty file list message', () => {
    expect(renderDropFiles({ instance: ORIGIN, name: 'site', files: [] })).toBe('No files in site');
  });
});

describe('list dispatch', () => {
  async function invoke(argv: string[], deps: ListDependencies) {
    const capture = { stdout: '', stderr: '' };
    const exitCode = await runCli(argv, {
      cwd: '/repo',
      stdout: { write: (value: string) => (capture.stdout += value) },
      stderr: { write: (value: string) => (capture.stderr += value) },
    }, undefined, { list: deps });
    return { ...capture, exitCode };
  }

  it('prints one JSON drop list document', async () => {
    const result = await invoke(['list', '--json'], dependencies());
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(listResult);
  });

  it('prints rendered drop lines for humans', async () => {
    const result = await invoke(['list'], dependencies());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2 files');
    expect(result.stdout).toContain('https://alice--site.content.example.com');
  });

  it('prints rendered file lines when a name is given', async () => {
    const result = await invoke(['list', 'site'], dependencies());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('index.html');
    expect(result.stdout).toContain('assets/app.js');
  });
});
