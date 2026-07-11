// ABOUTME: Verifies safe deterministic packaging of local files, directories, and existing ZIP archives.
// ABOUTME: Covers metadata exclusions, limits, symlink refusal, cleanup, aborts, and process signals.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { packageSource } from '../src/packageSource.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'drops-cli-package-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function zipEntries(path: string): Promise<string[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', path]);
  return stdout.trim().split('\n').filter(Boolean);
}

async function zipEntry(path: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', path, entry]);
  return stdout;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('packageSource', () => {
  it('archives sorted directory contents at the zip root and skips exact metadata names and segments', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'site');
    await mkdir(join(source, 'assets', '__MACOSX'), { recursive: true });
    await mkdir(join(source, '.AppleDouble'), { recursive: true });
    await writeFile(join(source, 'z.txt'), 'zed');
    await writeFile(join(source, 'assets', 'a.txt'), 'aye');
    await writeFile(join(source, 'assets', '.DS_Store'), 'junk');
    await writeFile(join(source, 'assets', '__MACOSX', 'junk'), 'junk');
    await writeFile(join(source, '.AppleDouble', 'junk'), 'junk');
    await writeFile(join(source, 'Thumbs.db'), 'junk');
    await writeFile(join(source, 'desktop.ini'), 'junk');
    await writeFile(join(source, '.thumbnail'), 'junk');
    await writeFile(join(source, 'DS_Store'), 'keep');

    const packaged = await packageSource(source);

    expect(await zipEntries(packaged.path)).toEqual(['DS_Store', 'assets/a.txt', 'z.txt']);
    expect(await zipEntry(packaged.path, 'assets/a.txt')).toBe('aye');
    expect(packaged.byteSize).toBe((await stat(packaged.path)).size);
    await packaged.cleanup();
    await expect(stat(packaged.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await packaged.cleanup();
  });

  it('archives a regular non-zip file at the root using its basename', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'hello.txt');
    await writeFile(source, 'hello');

    const packaged = await packageSource(source);

    expect(await zipEntries(packaged.path)).toEqual(['hello.txt']);
    expect(await zipEntry(packaged.path, 'hello.txt')).toBe('hello');
    await packaged.cleanup();
    expect(await readFile(source, 'utf8')).toBe('hello');
  });

  it('passes through an existing zip without modifying or deleting it and checks compressed size', async () => {
    const root = await temporaryDirectory();
    const text = join(root, 'source.txt');
    const zip = join(root, 'source.zip');
    await writeFile(text, 'hello');
    await execFileAsync('zip', ['-q', '-j', zip, text]);
    const before = await readFile(zip);

    const packaged = await packageSource(zip);

    expect(packaged).toMatchObject({ path: zip, byteSize: before.length });
    await packaged.cleanup();
    expect(await readFile(zip)).toEqual(before);
  });

  it.each(['missing', 'unsupported'])('rejects a %s source', async (kind) => {
    const root = await temporaryDirectory();
    const source = join(root, kind);
    if (kind === 'unsupported') await mkdir(source);
    if (kind === 'unsupported') {
      // A FIFO is an unsupported source type; skip on platforms without mkfifo.
      await rm(source, { recursive: true });
      await execFileAsync('mkfifo', [source]);
    }

    await expect(packageSource(source)).rejects.toMatchObject({
      code: kind === 'missing' ? 'source_not_found' : 'source_unsupported',
      exitCode: 2,
    });
  });

  it('rejects a symlink source and a symlink anywhere in a directory without following it', async () => {
    const root = await temporaryDirectory();
    const outside = join(root, 'outside.txt');
    const direct = join(root, 'direct-link');
    const source = join(root, 'site');
    await writeFile(outside, 'secret');
    await symlink(outside, direct);
    await mkdir(source);
    await writeFile(join(source, 'index.html'), 'ok');
    await symlink(outside, join(source, 'nested-link'));

    await expect(packageSource(direct)).rejects.toMatchObject({ code: 'source_symlink', exitCode: 2 });
    await expect(packageSource(source)).rejects.toMatchObject({ code: 'source_symlink', exitCode: 2 });
  });

  it('rejects per-file, total-size, and file-count limits before generating an archive', async () => {
    const root = await temporaryDirectory();
    const perFile = join(root, 'large.bin');
    await writeFile(perFile, '');
    await truncate(perFile, 25 * 1024 * 1024 + 1);
    await expect(packageSource(perFile)).rejects.toMatchObject({ code: 'per_file_size', exitCode: 2 });

    const total = join(root, 'total');
    await mkdir(total);
    for (let index = 0; index < 5; index += 1) {
      const path = join(total, `${index}.bin`);
      await writeFile(path, '');
      await truncate(path, 21 * 1024 * 1024);
    }
    await expect(packageSource(total)).rejects.toMatchObject({ code: 'total_size', exitCode: 2 });

    const count = join(root, 'count');
    await mkdir(count);
    await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(join(count, `${index}.txt`), '')));
    await expect(packageSource(count)).rejects.toMatchObject({ code: 'file_count', exitCode: 2 });
  });

  it('cleans a generated archive when aborted after packaging', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'site');
    await mkdir(source);
    await writeFile(join(source, 'index.html'), 'hello');
    const controller = new AbortController();
    const packaged = await packageSource(source, { signal: controller.signal });

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(stat(packaged.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await packaged.cleanup();
  });

  it('returns one in-flight cleanup promise and waits for delayed deletion', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'site');
    await mkdir(source);
    await writeFile(join(source, 'index.html'), 'hello');
    let releaseRemoval: (() => void) | undefined;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const removeTemporaryDirectory = vi.fn(async (path: string) => {
      await removalGate;
      await rm(path, { recursive: true, force: true });
    });
    const packaged = await packageSource(source, { removeTemporaryDirectory });

    const first = packaged.cleanup();
    const second = packaged.cleanup();
    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();

    expect(first).toBe(second);
    expect(settled).toBe(false);
    releaseRemoval?.();
    await first;
    expect(removeTemporaryDirectory).toHaveBeenCalledOnce();
    await expect(stat(packaged.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('awaits temporary deletion when archive generation fails', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'site');
    await mkdir(source);
    await writeFile(join(source, 'index.html'), 'hello');
    const removed: string[] = [];

    await expect(packageSource(source, {
      writeArchive: async () => { throw new Error('archive failed'); },
      removeTemporaryDirectory: async (path) => {
        removed.push(path);
        await rm(path, { recursive: true, force: true });
      },
    })).rejects.toThrow('archive failed');

    expect(removed).toHaveLength(1);
    await expect(stat(removed[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('awaits temporary deletion for a pre-aborted signal', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'site');
    await mkdir(source);
    await writeFile(join(source, 'index.html'), 'hello');
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));
    let removed = false;

    await expect(packageSource(source, {
      signal: controller.signal,
      removeTemporaryDirectory: async (path) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await rm(path, { recursive: true, force: true });
        removed = true;
      },
    })).rejects.toThrow('already aborted');

    expect(removed).toBe(true);
  });
});

describe('import safety', () => {
  it('does not install signal listeners when lifecycle modules are only imported', async () => {
    const script = [
      "const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];",
      `await import(${JSON.stringify(new URL('../src/packageSource.ts', import.meta.url).href)});`,
      `await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});`,
      "const after = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];",
      'process.stdout.write(JSON.stringify({ before, after }));',
    ].join('\n');
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script]);

    expect(JSON.parse(stdout)).toEqual({ before: [0, 0], after: [0, 0] });
  });
});

describe.each([
  ['SIGINT', 2],
  ['SIGTERM', 15],
] as const)('process lifecycle %s', (signal, signalNumber) => {
  it('awaits registered cleanup before exiting with the conventional code', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'site');
    const marker = join(root, 'archive-path');
    await mkdir(source);
    await writeFile(join(source, 'index.html'), 'hello');
    const script = [
      `import { createLifecycleRegistry } from ${JSON.stringify(new URL('../src/lifecycle.ts', import.meta.url).href)};`,
      `import { packageSource } from ${JSON.stringify(new URL('../src/packageSource.ts', import.meta.url).href)};`,
      `import { installSignalHandlers } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};`,
      'const lifecycle = createLifecycleRegistry();',
      'installSignalHandlers(lifecycle);',
      `const packaged = await packageSource(${JSON.stringify(source)}, { registerCleanup: lifecycle.register });`,
      `await (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, packaged.path);`,
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
    });
    const archivePath = await readFile(marker, 'utf8');

    child.kill(signal);
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));

    expect(exitCode).toBe(128 + signalNumber);
    await expect(stat(archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
