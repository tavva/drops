// ABOUTME: Canonicalises safe Drops origins and resolves them from flags or repository config.
// ABOUTME: Allows insecure HTTP only for loopback development instances and never uses a global default.
import { findNearestConfig, readConfig } from './config.js';
import { DropsCliError } from './errors.js';

function invalidInstance(message: string): DropsCliError {
  return new DropsCliError({ code: 'instance_invalid', message, exitCode: 2 });
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (!host.startsWith('127.')) return false;
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function canonicaliseInstance(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInstance('Instance must be a valid absolute URL');
  }

  if (url.username || url.password) throw invalidInstance('Instance must not contain credentials');
  if (url.pathname !== '/') throw invalidInstance('Instance must not contain a path');
  if (url.search) throw invalidInstance('Instance must not contain a query');
  if (url.hash) throw invalidInstance('Instance must not contain a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw invalidInstance('Instance must use HTTPS, except for loopback development origins');
  }

  return url.origin;
}

export interface ResolveInstanceOptions {
  cwd: string;
  explicit?: string;
}

export async function resolveInstance(options: ResolveInstanceOptions): Promise<string> {
  if (options.explicit !== undefined) return canonicaliseInstance(options.explicit);

  const configPath = await findNearestConfig(options.cwd);
  if (configPath !== null) {
    const config = await readConfig(configPath);
    return canonicaliseInstance(config.instance);
  }

  throw new DropsCliError({
    code: 'instance_required',
    message: 'No Drops instance is configured for this repository.',
    guidance: {
      hint: 'Configure this repository with drops init, or select an instance for this command with --instance.',
      examples: [
        'drops init --instance https://drops.example.com',
        'drops deploy ./dist --name preview --instance https://drops.example.com',
      ],
    },
    exitCode: 2,
  });
}
