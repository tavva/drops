// ABOUTME: Verifies portable .drops.json parsing and safe initialisation behavior.
// ABOUTME: Ensures configuration contains only a canonical instance and is not overwritten implicitly.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initialiseConfig, readConfig } from '../src/config.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'drops-cli-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('readConfig', () => {
  it('reads the exact portable config shape', async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, '.drops.json');
    await writeFile(path, '{"instance":"https://drops.example.com"}\n');

    await expect(readConfig(path)).resolves.toEqual({ instance: 'https://drops.example.com' });
  });

  it.each([
    '{}',
    '{"instance":42}',
    '{"instance":"https://drops.example.com","token":"drops_cli_secret"}',
  ])('rejects config outside the exact portable shape: %s', async (contents) => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, '.drops.json');
    await writeFile(path, `${contents}\n`);

    await expect(readConfig(path)).rejects.toMatchObject({ code: 'config_invalid', exitCode: 2 });
  });
});

describe('initialiseConfig', () => {
  it('writes only the canonical instance in the requested directory', async () => {
    const cwd = await temporaryDirectory();

    const result = await initialiseConfig({ cwd, instance: 'HTTPS://Drops.Example.com/', force: false });

    expect(result).toEqual({ path: join(cwd, '.drops.json'), instance: 'https://drops.example.com' });
    expect(await readFile(result.path, 'utf8')).toBe('{"instance":"https://drops.example.com"}\n');
  });

  it('refuses to overwrite without an explicit force request', async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, '.drops.json');
    await writeFile(path, '{"instance":"https://existing.example.com"}\n');

    await expect(initialiseConfig({ cwd, instance: 'https://new.example.com', force: false })).rejects.toMatchObject({
      code: 'config_exists',
      exitCode: 2,
    });
    expect(await readFile(path, 'utf8')).toBe('{"instance":"https://existing.example.com"}\n');
  });

  it('overwrites when force is explicitly requested', async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, '.drops.json');
    await writeFile(path, '{"instance":"https://existing.example.com"}\n');

    await initialiseConfig({ cwd, instance: 'https://new.example.com', force: true });

    expect(await readFile(path, 'utf8')).toBe('{"instance":"https://new.example.com"}\n');
  });
});
