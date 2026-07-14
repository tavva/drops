// ABOUTME: Verifies canonical Drops instance origins and repository-local instance resolution.
// ABOUTME: Covers safe URL constraints, explicit precedence, ancestor lookup, and missing configuration.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicaliseInstance, resolveInstance } from '../src/instance.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'drops-cli-instance-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('canonicaliseInstance', () => {
  it('canonicalises an HTTPS origin', () => {
    expect(canonicaliseInstance('HTTPS://Drops.Example.com/')).toBe('https://drops.example.com');
  });

  it('retains an explicit non-default port', () => {
    expect(canonicaliseInstance('https://Drops.Example.com:8443/')).toBe('https://drops.example.com:8443');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'allows loopback HTTP at %s',
    (origin) => {
      expect(canonicaliseInstance(origin)).toBe(origin);
    },
  );

  it.each([
    'not a URL',
    'ftp://drops.example.com',
    'http://drops.example.com',
    'https://u:p@drops.example.com',
    'https://drops.example.com/path',
    'https://drops.example.com/?query=yes',
    'https://drops.example.com/#fragment',
  ])('rejects the unsafe instance URL %s', (origin) => {
    let thrown: unknown;
    try {
      canonicaliseInstance(origin);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'instance_invalid', exitCode: 2 });
  });
});

describe('resolveInstance', () => {
  it('prefers the explicit instance over repository configuration', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.drops.json'), '{"instance":"https://config.example.com"}\n');

    await expect(resolveInstance({ cwd, explicit: 'https://flag.example.com/' })).resolves.toBe(
      'https://flag.example.com',
    );
  });

  it('uses the nearest ancestor configuration', async () => {
    const root = await temporaryDirectory();
    const project = join(root, 'project');
    const nested = join(project, 'build', 'output');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, '.drops.json'), '{"instance":"https://root.example.com"}\n');
    await writeFile(join(project, '.drops.json'), '{"instance":"https://Drops.Example.com/"}\n');

    await expect(resolveInstance({ cwd: nested, explicit: undefined })).resolves.toBe('https://drops.example.com');
  });

  it('returns instance_required when no instance is configured', async () => {
    const cwd = await temporaryDirectory();

    await expect(resolveInstance({ cwd, explicit: undefined })).rejects.toMatchObject({
      code: 'instance_required',
      instance: null,
      guidance: {
        hint: 'Configure this repository with drops init, or select an instance for this command with --instance.',
        examples: [
          'drops init --instance https://drops.example.com',
          'drops deploy ./dist --name preview --instance https://drops.example.com',
        ],
      },
      exitCode: 2,
    });
  });
});
