// ABOUTME: Exercises Linux credential storage against isolated temporary directories.
// ABOUTME: Checks permissions, atomic replacement, origin isolation, and unsafe filesystem entries.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { credentialDirectory, createCredentialStore, FileCredentialStore } from '../src/credentials.js';
import { MacOsKeychainStore } from '../src/keychain.js';

const directories: string[] = [];
const origin = 'https://drops.example.com';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'drops-credentials-'));
  directories.push(root);
  const directory = join(root, 'credentials');
  return { root, directory, store: new FileCredentialStore(directory) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('credential storage selection', () => {
  it('selects macOS Keychain or Linux files without accessing either store', () => {
    expect(createCredentialStore('darwin')).toBeInstanceOf(MacOsKeychainStore);
    expect(createCredentialStore('linux')).toBeInstanceOf(FileCredentialStore);
  });

  it('reports unsupported platforms only when credentials are needed', async () => {
    await expect(createCredentialStore('win32').get(origin)).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('uses an absolute XDG config path or the home directory, never the working directory', () => {
    expect(credentialDirectory({}, '/home/alice')).toBe('/home/alice/.config/drops/credentials');
    expect(credentialDirectory({ XDG_CONFIG_HOME: '/config' }, '/home/alice')).toBe('/config/drops/credentials');
    expect(credentialDirectory({ XDG_CONFIG_HOME: './repo' }, '/home/alice')).toBe('/home/alice/.config/drops/credentials');
  });
});

describe('FileCredentialStore', () => {
  it('round trips, replaces, and deletes credentials with private permissions', async () => {
    const { directory, store } = await fixture();
    await expect(store.get(origin)).resolves.toBeNull();
    await expect(store.delete(origin)).resolves.toBeUndefined();
    await store.set(origin, 'first-secret');
    await expect(new FileCredentialStore(directory).get(origin)).resolves.toBe('first-secret');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    await store.set(origin, 'replacement-secret');
    await expect(store.get(origin)).resolves.toBe('replacement-secret');
    expect(await readdir(directory)).toEqual(files);
    await store.delete(origin);
    await expect(store.get(origin)).resolves.toBeNull();
    await expect(store.delete(origin)).resolves.toBeUndefined();
  });

  it('preserves independent concurrent writes for distinct exact origins', async () => {
    const { store } = await fixture();
    const other = `${origin}:8443`;
    await Promise.all([store.set(origin, 'one'), store.set(other, 'two')]);
    await store.delete(origin);
    await expect(store.get(other)).resolves.toBe('two');
    await expect(store.get(origin)).resolves.toBeNull();
  });

  it('rejects public directories and symlink directories', async () => {
    const { root, directory, store } = await fixture();
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await expect(store.set(origin, 'secret')).rejects.toMatchObject({ code: 'credential_store_unavailable' });
    await rm(directory, { recursive: true });
    await symlink(root, directory);
    await expect(store.set(origin, 'secret')).rejects.toMatchObject({ code: 'credential_store_unavailable' });
    await expect(store.get(origin)).rejects.toMatchObject({ code: 'credential_store_unavailable' });
  });

  it('rejects public files, malformed data, and credentials belonging to a different origin', async () => {
    const { directory, store } = await fixture();
    await store.set(origin, 'private-secret');
    const path = join(directory, (await readdir(directory))[0]!);
    await chmod(path, 0o644);
    await expect(store.get(origin)).rejects.toMatchObject({ code: 'credential_store_unavailable' });
    await chmod(path, 0o600);
    for (const contents of ['private-secret malformed JSON', JSON.stringify({ origin: 'https://other.example', token: 'private-secret' })]) {
      await writeFile(path, contents);
      try {
        await store.get(origin);
        expect.fail('Unsafe credentials were accepted');
      } catch (error) {
        expect(error).toMatchObject({ code: 'credential_store_unavailable', exitCode: 3 });
        expect(String(error)).not.toContain('private-secret');
      }
    }
  });

  it('never reads or overwrites a symlink target', async () => {
    const { root, directory, store } = await fixture();
    await store.set(origin, 'original');
    const path = join(directory, (await readdir(directory))[0]!);
    const target = join(root, 'target');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    await expect(store.get(origin)).rejects.toMatchObject({ code: 'credential_store_unavailable' });
    await store.set(origin, 'replacement');
    await expect(store.get(origin)).resolves.toBe('replacement');
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });
});
