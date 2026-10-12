// ABOUTME: Parses the drops pull command shape and renders its one-line human summary.
// ABOUTME: Accepts a drop reference, an optional destination directory, --instance, and --json.
import { parseArgs } from 'node:util';

import { argumentErrorMessage, commandUsageError } from '../help.js';
import type { PullResult } from '../pull.js';
import { formatByteSize } from './list.js';

export interface ParsedPullArguments {
  reference: string;
  directory?: string;
  instance?: string;
  json: boolean;
}

export function parsePullArguments(argv: string[]): ParsedPullArguments {
  const instanceOccurrences = argv.filter(
    (argument) => argument === '--instance' || argument.startsWith('--instance='),
  ).length;
  if (instanceOccurrences > 1) throw commandUsageError('pull', 'Provide --instance at most once.');
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
    if (error instanceof TypeError) throw commandUsageError('pull', argumentErrorMessage(error));
    throw error;
  }
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    throw commandUsageError('pull', 'Provide one drop reference and at most one directory.');
  }
  return {
    reference: parsed.positionals[0]!,
    ...(parsed.positionals[1] === undefined ? {} : { directory: parsed.positionals[1] }),
    ...(parsed.values.instance === undefined ? {} : { instance: parsed.values.instance }),
    json: parsed.values.json,
  };
}

export function renderPullResult(result: PullResult): string {
  const files = `${result.fileCount} ${result.fileCount === 1 ? 'file' : 'files'}`;
  return `Pulled ${result.owner}/${result.name} (${files}, ${formatByteSize(result.byteSize)}) to ${result.directory}`;
}
