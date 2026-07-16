// ABOUTME: Parses the drops list command shape and renders drop and file listings for humans.
// ABOUTME: A bare invocation lists the user's drops; a positional name lists one drop's files.
import { parseArgs } from 'node:util';

import type { DropsFilesResult, DropsListResult } from '../api.js';
import { argumentErrorMessage, commandUsageError } from '../help.js';
import { list, type ListDependencies } from '../list.js';

export interface ParsedListArguments {
  name?: string;
  instance?: string;
  json: boolean;
}

export function parseListArguments(argv: string[]): ParsedListArguments {
  const instanceOccurrences = argv.filter(
    (argument) => argument === '--instance' || argument.startsWith('--instance='),
  ).length;
  if (instanceOccurrences > 1) throw commandUsageError('list', 'Provide --instance at most once.');
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        instance: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof TypeError) throw commandUsageError('list', argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length > 1) throw commandUsageError('list', 'Provide at most one drop name.');
  return {
    ...(parsed.positionals[0] === undefined ? {} : { name: parsed.positionals[0] }),
    ...(parsed.values.instance === undefined ? {} : { instance: parsed.values.instance }),
    json: parsed.values.json,
  };
}

export async function runListCommand(
  options: ParsedListArguments & { cwd: string },
  dependencies?: ListDependencies,
) {
  return list({ cwd: options.cwd, name: options.name, instance: options.instance }, dependencies);
}

export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 'B';
  for (const next of ['KB', 'MB', 'GB']) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const rounded = unit === 'B' || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

export function renderDropsList(result: DropsListResult): string {
  if (result.drops.length === 0) return `No drops on ${result.instance}`;
  return result.drops.map((drop) => [
    drop.name,
    drop.url,
    `${drop.fileCount} ${drop.fileCount === 1 ? 'file' : 'files'}`,
    formatByteSize(drop.byteSize),
    `updated ${drop.updatedAt.slice(0, 10)}`,
  ].join('  ')).join('\n');
}

export function renderDropFiles(result: DropsFilesResult): string {
  if (result.files.length === 0) return `No files in ${result.name}`;
  return result.files
    .map((file) => `${formatByteSize(file.size).padStart(9)}  ${file.path}`)
    .join('\n');
}
