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
  const archive = join(archiveDirectory, archives[0]);

  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  for (const required of ['package/README.md', 'package/LICENSE', 'package/package.json', 'package/dist/index.js']) {
    if (!entries.includes(required)) throw new Error(`Packed archive is missing ${required}`);
  }
  if (entries.some((entry) => entry.startsWith('package/src/') || entry.startsWith('package/tests/'))) {
    throw new Error('Packed archive must not contain source or test files');
  }

  const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  for (const field of ['description', 'license', 'author', 'repository', 'homepage']) {
    if (!metadata[field]) throw new Error(`Packed package metadata is missing ${field}`);
  }
  if (metadata.license !== 'MIT') throw new Error('Packed package must use the MIT licence');

  const entryPoint = execFileSync(
    'tar',
    ['-xOf', archive, 'package/dist/index.js'],
    { encoding: 'utf8' },
  );
  if (!entryPoint.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('Packed dist/index.js is missing its Node shebang');
  }

  process.stdout.write('Packed CLI metadata, docs, licence, allowlist, and executable are valid.\n');
} finally {
  rmSync(archiveDirectory, { recursive: true, force: true });
}
