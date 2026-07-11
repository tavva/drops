// ABOUTME: Reads and writes portable repository-local Drops CLI instance configuration.
// ABOUTME: Searches ancestors for .drops.json without storing credentials or machine-local defaults.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import { DropsCliError } from './errors.js';
import { canonicaliseInstance } from './instance.js';

export const CONFIG_FILE_NAME = '.drops.json';

export interface DropsConfig {
  instance: string;
}

function isDropsConfig(value: unknown): value is DropsConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.instance === 'string';
}

export async function readConfig(path: string): Promise<DropsConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DropsCliError({
      code: 'config_invalid',
      message: `Could not read a valid ${CONFIG_FILE_NAME} at ${path}`,
      details: { path },
      exitCode: 2,
    });
  }

  if (!isDropsConfig(parsed)) {
    throw new DropsCliError({
      code: 'config_invalid',
      message: `${CONFIG_FILE_NAME} must contain exactly one string property named instance`,
      details: { path },
      exitCode: 2,
    });
  }

  return parsed;
}

export async function findNearestConfig(cwd: string): Promise<string | null> {
  let directory = resolve(cwd);
  const root = parse(directory).root;

  while (true) {
    const candidate = join(directory, CONFIG_FILE_NAME);
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new DropsCliError({
          code: 'config_invalid',
          message: `Could not read ${candidate}`,
          details: { path: candidate },
          exitCode: 2,
        });
      }
    }

    if (directory === root) return null;
    directory = dirname(directory);
  }
}

export interface InitialiseConfigOptions {
  cwd: string;
  instance: string;
  force: boolean;
}

export async function initialiseConfig(options: InitialiseConfigOptions): Promise<{ path: string; instance: string }> {
  const path = join(resolve(options.cwd), CONFIG_FILE_NAME);
  const instance = canonicaliseInstance(options.instance);
  const contents = `${JSON.stringify({ instance })}\n`;

  try {
    await writeFile(path, contents, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DropsCliError({
        code: 'config_exists',
        message: `${path} already exists; pass --force to overwrite it`,
        instance,
        details: { path },
        exitCode: 2,
      });
    }
    throw new DropsCliError({
      code: 'config_write_failed',
      message: `Could not write ${path}`,
      instance,
      details: { path },
      exitCode: 2,
    });
  }

  return { path, instance };
}
