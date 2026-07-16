#!/usr/bin/env node
// ABOUTME: Test-only executable harness for running the built CLI with private file credentials.
// ABOUTME: Injects browser and credential adapters without adding environment seams to production code.
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DropsApiClient } from '../../../packages/cli/dist/api.js';
import { createAuthDependencies } from '../../../packages/cli/dist/auth.js';
import { createDeployDependencies } from '../../../packages/cli/dist/deploy.js';
import { runCli } from '../../../packages/cli/dist/index.js';
import { createListDependencies } from '../../../packages/cli/dist/list.js';
import { createLifecycleRegistry } from '../../../packages/cli/dist/lifecycle.js';

const credentialsPath = process.env.DROPS_CLI_TEST_CREDENTIALS;
const openedUrlPath = process.env.DROPS_CLI_TEST_OPENED_URL;
if (!credentialsPath || !openedUrlPath) throw new Error('Missing test harness paths');

class PrivateFileCredentialStore {
  async read() {
    try {
      const parsed = JSON.parse(await readFile(credentialsPath, 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async write(entries) {
    const temporary = resolve(dirname(credentialsPath), `.credentials-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, credentialsPath);
      await chmod(credentialsPath, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(origin) {
    const value = (await this.read())[origin];
    return typeof value === 'string' ? value : null;
  }

  async set(origin, token) {
    await this.write({ ...(await this.read()), [origin]: token });
  }

  async delete(origin) {
    const entries = await this.read();
    delete entries[origin];
    await this.write(entries);
  }
}

const store = new PrivateFileCredentialStore();
const openBrowser = async (url) => {
  await writeFile(openedUrlPath, url, { mode: 0o600, flag: 'w' });
  await chmod(openedUrlPath, 0o600);
};
const lifecycle = createLifecycleRegistry();
const auth = { ...createAuthDependencies(openBrowser), api: new DropsApiClient(), store };
const deploy = { ...createDeployDependencies(lifecycle.register), api: new DropsApiClient(), store };
const list = { ...createListDependencies(), api: new DropsApiClient(), store };

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }, undefined, { auth, deploy, list });
} finally {
  await lifecycle.cleanup();
}
