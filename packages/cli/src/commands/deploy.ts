// ABOUTME: Parses the exact drops deploy command shape and invokes deployment orchestration.
// ABOUTME: Produces stable usage errors for missing paths, duplicate paths, and missing names.
import { parseArgs } from 'node:util';

import { deploy, type DeployDependencies } from '../deploy.js';
import { DropsCliError } from '../errors.js';

const USAGE = 'Usage: drops deploy <path> --name <name> [--instance <origin>] [--json]';

function usage(message: string): DropsCliError {
  return new DropsCliError({ code: 'usage_error', message, exitCode: 2 });
}

export interface ParsedDeployArguments {
  path: string;
  name: string;
  instance?: string;
  json: boolean;
}

export function parseDeployArguments(argv: string[]): ParsedDeployArguments {
  const nameOccurrences = argv.filter((argument) => argument === '--name' || argument.startsWith('--name=')).length;
  if (nameOccurrences > 1) throw usage(`${USAGE}; provide --name exactly once`);

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        instance: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof TypeError) throw usage(`${USAGE}; ${error.message}`);
    throw error;
  }

  if (parsed.positionals.length === 0) throw usage(USAGE);
  if (parsed.positionals.length !== 1) throw usage(`${USAGE}; provide exactly one source path`);
  if (parsed.values.name === undefined) throw usage(`${USAGE}; --name is required`);
  return {
    path: parsed.positionals[0]!,
    name: parsed.values.name,
    ...(parsed.values.instance === undefined ? {} : { instance: parsed.values.instance }),
    json: parsed.values.json,
  };
}

export interface RunDeployCommandOptions extends ParsedDeployArguments {
  cwd: string;
  onProgress: (uploadedBytes: number, totalBytes: number) => void;
}

export async function runDeployCommand(options: RunDeployCommandOptions, dependencies?: DeployDependencies) {
  return deploy(
    {
      cwd: options.cwd,
      path: options.path,
      name: options.name,
      instance: options.instance,
      onProgress: options.onProgress,
    },
    dependencies,
  );
}
