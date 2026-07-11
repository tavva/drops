// ABOUTME: Verifies a clean CLI package pack builds and includes its executable entry point.
// ABOUTME: Removes ignored output first, packs to a temporary archive, and checks the archived Node shebang.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const archiveDirectory = mkdtempSync(join(tmpdir(), 'drops-cli-pack-'));

try {
  rmSync(join(packageDirectory, 'dist'), { recursive: true, force: true });
  execFileSync('pnpm', ['pack', '--pack-destination', archiveDirectory], {
    cwd: packageDirectory,
    stdio: 'pipe',
  });

  const archives = readdirSync(archiveDirectory).filter((entry) => entry.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error(`Expected one package archive, found ${archives.length}`);

  const entryPoint = execFileSync(
    'tar',
    ['-xOf', join(archiveDirectory, archives[0]), 'package/dist/index.js'],
    { encoding: 'utf8' },
  );
  if (!entryPoint.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('Packed dist/index.js is missing its Node shebang');
  }

  process.stdout.write('Packed dist/index.js contains a usable Node shebang.\n');
} finally {
  rmSync(archiveDirectory, { recursive: true, force: true });
}
