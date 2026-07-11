// ABOUTME: Full-system Playwright coverage for the built CLI against real Drops HTTP, Postgres, and R2.
// ABOUTME: A test-only child harness injects file credentials/browser opening; production has no test backdoor.
import { test, expect } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChildProcessTracker, spawnWithResult, type SpawnResult } from './helpers/processes';

async function availablePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Could not allocate test port');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

const appPort = await availablePort();
const APP_ORIGIN = `http://127.0.0.1:${appPort}`;
const CONTENT_ORIGIN = `http://content.localtest.me:${appPort}`;

process.env.DATABASE_URL ??= 'postgres://drops:drops@localhost:55432/drops_test';
process.env.R2_ENDPOINT ??= 'http://localhost:9000';
process.env.R2_ACCOUNT_ID ??= 'minio';
process.env.R2_ACCESS_KEY_ID ??= 'minioadmin';
process.env.R2_SECRET_ACCESS_KEY ??= 'minioadmin';
process.env.R2_BUCKET ??= 'drops-test';
process.env.GOOGLE_CLIENT_ID ??= 'test';
process.env.GOOGLE_CLIENT_SECRET ??= 'test';
process.env.SESSION_SECRET ??= 's'.repeat(64);
process.env.ALLOWED_DOMAIN ??= 'example.com';
process.env.APP_ORIGIN ??= 'http://drops.localtest.me:3000';
process.env.CONTENT_ORIGIN ??= 'http://content.localtest.me:3000';
process.env.PORT ??= '3000';
process.env.LOG_LEVEL ??= 'silent';

function runCli(
  args: string[],
  options: { cwd: string; credentials: string; openedUrl: string; tracker: ChildProcessTracker },
): Promise<SpawnResult> {
  return spawnWithResult(
    process.execPath,
    [
      resolve('tests/e2e/helpers/cli-child.mjs'),
      ...args,
    ],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        DROPS_CLI_TEST_CREDENTIALS: options.credentials,
        DROPS_CLI_TEST_OPENED_URL: options.openedUrl,
      },
      tracker: options.tracker,
      timeoutMs: 15_000,
    },
  );
}

async function waitForOpenedUrl(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await readFile(path, 'utf8');
      if (value.length > 0) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('CLI did not request browser authorisation');
}

function startFullServer(tracker: ChildProcessTracker): Promise<ChildProcess> {
  return new Promise((resolveServer, reject) => {
    const child = tracker.spawn(process.execPath, ['--import', 'tsx', resolve('tests/e2e/helpers/full-server.ts')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ORIGIN,
        CONTENT_ORIGIN,
        PORT: String(appPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await tracker.terminate(child).catch(() => undefined);
      reject(error);
    };
    const timeout = setTimeout(() => {
      void fail(new Error(`Drops test server timed out: ${stdout} ${stderr}`));
    }, 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes('READY\n')) {
        settled = true;
        clearTimeout(timeout);
        resolveServer(child);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      void fail(error);
    });
    child.once('exit', (code) => {
      if (!settled) void fail(new Error(`Drops test server exited ${code}: ${stdout} ${stderr}`));
    });
  });
}

function parseJson(result: SpawnResult): Record<string, unknown> {
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  server.closeAllConnections();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('HTTP test server close timed out')), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test('built executable handles safe local commands without injected dependencies', async () => {
  // This layer runs dist/index.js exactly as published. It never calls login, so /usr/bin/open is
  // untouched; auth/deploy perform only a missing-item lookup for a fresh exact loopback origin
  // and never add, update, or delete a Keychain item. The injected journey below owns full login.
  const temp = await mkdtemp(join(tmpdir(), 'drops-cli-bin-smoke-'));
  const tracker = new ChildProcessTracker();
  const bin = resolve('packages/cli/dist/index.js');
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const invoke = (args: string[]) => spawnWithResult(process.execPath, [bin, ...args], {
    cwd: temp,
    tracker,
    timeoutMs: 10_000,
  });

  try {
    const help = await invoke(['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).not.toContain('Error [');
    expect(help.stdout).toContain('drops <login|logout|auth status|init|deploy>');

    const init = await invoke(['init', '--instance', origin, '--json']);
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(temp, '.drops.json'), 'utf8'))).toEqual({ instance: origin });

    const status = await invoke(['auth', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    expect(parseJson(status)).toMatchObject({ instance: origin, authenticated: false, user: null });

    await mkdir(join(temp, 'site'));
    await writeFile(join(temp, 'site', 'index.html'), '<h1>not uploaded</h1>\n');
    const deploy = await invoke(['deploy', './site', '--name', 'missing-auth', '--json']);
    expect(deploy.exitCode).toBe(3);
    expect(parseJson(deploy)).toMatchObject({ error: { code: 'not_authenticated', instance: origin } });
  } finally {
    const cleanup = await Promise.allSettled([tracker.terminateAll()]);
    await rm(temp, { recursive: true, force: true });
    const failed = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
});

test('login, configure, deploy, serve, select instances, and revoke CLI access', async ({ request }) => {
  const temp = await mkdtemp(join(tmpdir(), 'drops-cli-e2e-'));
  const repo = join(temp, 'repo');
  const credentials = join(temp, 'credentials.json');
  const openedUrl = join(temp, 'opened-url');
  const tracker = new ChildProcessTracker();
  let secondServer: HttpServer | undefined;

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(repo, { mode: 0o700 }));
    const site = join(repo, 'site');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(site, { mode: 0o700 }));
    await writeFile(join(site, 'index.html'), '<!doctype html><h1>CLI fixture</h1>\n', { mode: 0o600 });
    await writeFile(join(site, 'asset.txt'), 'from a real zip\n', { mode: 0o600 });

    const { setupTestDatabase } = await import('../helpers/db');
    const { resetBucket } = await import('../helpers/r2');
    await setupTestDatabase();
    await resetBucket();
    const { db } = await import('../../src/db');
    const { cliTokens, drops, sessions, users } = await import('../../src/db/schema');
    const [user] = await db.insert(users).values({
      email: 'cli-user@example.com',
      username: 'cli-user',
    }).returning();
    const { createSession } = await import('../../src/services/sessions');
    const { signCookie, signDropCookie } = await import('../../src/lib/cookies');
    const { issueCsrfToken } = await import('../../src/lib/csrf');
    const sid = await createSession(user!.id);

    await startFullServer(tracker);

    const csrf = issueCsrfToken(sid);
    const browserCookie = [
      `drops_session=${signCookie(sid, process.env.SESSION_SECRET!)}`,
      `drops_csrf=${csrf}`,
    ].join('; ');

    const childOptions = { cwd: repo, credentials, openedUrl, tracker };
    const loginPromise = runCli(['login', APP_ORIGIN, '--json'], childOptions);
    const authorizationUrl = await Promise.race([
      waitForOpenedUrl(openedUrl),
      loginPromise.then((result) => Promise.reject(new Error(
        `CLI exited before browser authorisation: ${result.exitCode} ${result.stdout} ${result.stderr}`,
      ))),
    ]);
    expect(new URL(authorizationUrl).origin).toBe(APP_ORIGIN);
    const authorizationPage = await request.get(authorizationUrl, {
      headers: { cookie: browserCookie },
      maxRedirects: 0,
    });
    expect(authorizationPage.status()).toBe(200);
    expect(await authorizationPage.text()).toContain('Authorise Drops CLI');
    const authorization = new URL(authorizationUrl);
    const approval = await request.post(`${APP_ORIGIN}/app/cli/authorize/approve`, {
      headers: { cookie: browserCookie, origin: APP_ORIGIN },
      form: {
        redirect_uri: authorization.searchParams.get('redirect_uri')!,
        state: authorization.searchParams.get('state')!,
        code_challenge: authorization.searchParams.get('code_challenge')!,
        code_challenge_method: 'S256',
        _csrf: csrf,
      },
    });
    expect(approval.status()).toBe(200);
    expect(await approval.text()).toContain('Authorisation complete.');
    const login = await loginPromise;
    expect(login.exitCode).toBe(0);
    expect(parseJson(login)).toMatchObject({
      instance: APP_ORIGIN,
      user: { email: 'cli-user@example.com', username: 'cli-user' },
    });
    expect(login.stdout).not.toContain('drops_cli_');
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);

    const init = await runCli(['init', '--instance', APP_ORIGIN, '--json'], childOptions);
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(repo, '.drops.json'), 'utf8'))).toEqual({ instance: APP_ORIGIN });
    expect(await readFile(join(repo, '.drops.json'), 'utf8')).not.toContain('drops_cli_');

    const deploy = await runCli(['deploy', './site', '--name', 'cli-preview', '--json'], childOptions);
    expect(deploy.exitCode).toBe(0);
    const deployed = parseJson(deploy);
    expect(deployed).toMatchObject({ instance: APP_ORIGIN, name: 'cli-preview', entryPath: null });
    expect(deployed.fileCount).toBeGreaterThanOrEqual(2);
    expect(deploy.stdout).not.toContain('drops_cli_');

    await db.update(drops).set({ viewMode: 'public' });
    const deployedUrl = new URL(deployed.url as string);
    const served = await fetch(deployedUrl, {
      headers: {
        cookie: `drops_drop_session=${signDropCookie(sid, deployedUrl.hostname, process.env.SESSION_SECRET!)}`,
      },
    });
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('CLI fixture');

    const status = await runCli(['auth', 'status', '--json'], childOptions);
    expect(parseJson(status)).toMatchObject({ instance: APP_ORIGIN, authenticated: true });

    // The second instance deliberately implements only minimal v1 discovery, whoami, and deploy
    // endpoints. It proves exactly three client boundaries: exact discovery-origin equality,
    // credential-key isolation by exact origin, and --instance precedence over .drops.json. The
    // first child server retains complete production-route coverage for login, deploy, content
    // serving, dashboard, and revocation.
    const secondPort = await availablePort();
    const secondOrigin = `http://127.0.0.1:${secondPort}`;
    let secondDiscoveryRequests = 0;
    let secondIdentityRequests = 0;
    let secondDeploymentRequests = 0;
    secondServer = createHttpServer((request, response) => {
      if (request.url === '/.well-known/drops') {
        secondDiscoveryRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ service: 'drops', apiVersion: 1, appOrigin: secondOrigin }));
        return;
      }
      if (request.url === '/api/v1/whoami' && request.headers.authorization === 'Bearer second-token') {
        secondIdentityRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'second-user', email: 'second@example.com', username: 'second' }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/api/v1/drops/second-preview/deployments'
        && request.headers.authorization === 'Bearer second-token'
      ) {
        secondDeploymentRequests += 1;
        request.resume();
        request.once('end', () => {
          response.statusCode = 201;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            instance: secondOrigin,
            name: 'second-preview',
            url: `${secondOrigin}/served-by-minimal-boundary`,
            versionId: 'minimal-v1-version',
            fileCount: 2,
            byteSize: 42,
            entryPath: null,
          }));
        });
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { code: 'not_authenticated', message: 'Invalid token' } }));
    });
    await new Promise<void>((resolveListen) => secondServer!.listen(secondPort, '127.0.0.1', resolveListen));
    const stored = JSON.parse(await readFile(credentials, 'utf8')) as Record<string, string>;
    stored[secondOrigin] = 'second-token';
    await writeFile(credentials, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    const overridden = await runCli(
      ['auth', 'status', '--instance', secondOrigin, '--json'],
      childOptions,
    );
    expect(parseJson(overridden)).toMatchObject({
      instance: secondOrigin,
      authenticated: true,
      user: { username: 'second' },
    });
    expect(secondIdentityRequests).toBe(1);
    const overriddenDeploy = await runCli([
      'deploy', './site', '--name', 'second-preview', '--instance', secondOrigin, '--json',
    ], childOptions);
    expect(overriddenDeploy.exitCode).toBe(0);
    expect(parseJson(overriddenDeploy)).toMatchObject({ instance: secondOrigin, name: 'second-preview' });
    expect(secondDiscoveryRequests).toBe(1);
    expect(secondDeploymentRequests).toBe(1);
    const isolatedCredentials = JSON.parse(await readFile(credentials, 'utf8')) as Record<string, string>;
    expect(isolatedCredentials[APP_ORIGIN]).toMatch(/^drops_cli_/u);
    expect(isolatedCredentials[secondOrigin]).toBe('second-token');

    const dashboard = await request.get(`${APP_ORIGIN}/app`, { headers: { cookie: browserCookie } });
    expect(dashboard.status()).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('<h2 id="cli-access-heading">CLI access</h2>');
    expect(dashboardHtml).toContain('Drops CLI on');
    const revokePath = dashboardHtml.match(/action="(\/app\/cli\/tokens\/[a-f0-9-]+\/revoke)"/u)?.[1];
    expect(revokePath).toBeDefined();
    const revoke = await request.post(`${APP_ORIGIN}${revokePath}`, {
      headers: { cookie: browserCookie, origin: APP_ORIGIN },
      form: { _csrf: csrf },
      maxRedirects: 0,
    });
    expect(revoke.status()).toBe(303);
    expect(revoke.headers().location).toBe('/app?cli_revoked=1');
    const revokedDashboard = await request.get(`${APP_ORIGIN}/app?cli_revoked=1`, {
      headers: { cookie: browserCookie },
    });
    expect(await revokedDashboard.text()).toContain('CLI access revoked.');
    expect(await db.select().from(cliTokens)).toHaveLength(1);

    const revokedStatus = await runCli(['auth', 'status', '--json'], childOptions);
    expect(revokedStatus.exitCode).toBe(0);
    expect(parseJson(revokedStatus)).toMatchObject({ instance: APP_ORIGIN, authenticated: false, user: null });
    const afterStatus = JSON.parse(await readFile(credentials, 'utf8')) as Record<string, string>;
    expect(afterStatus[APP_ORIGIN]).toBeUndefined();
    expect(afterStatus[secondOrigin]).toBe('second-token');

    const revokedDeploy = await runCli(['deploy', './site', '--name', 'after-revoke', '--json'], childOptions);
    expect(revokedDeploy.exitCode).toBe(3);
    expect(parseJson(revokedDeploy)).toMatchObject({ error: { code: 'not_authenticated', instance: APP_ORIGIN } });
    expect(`${revokedDeploy.stdout}${revokedDeploy.stderr}`).not.toContain('drops_cli_');

    await db.delete(sessions);
  } finally {
    const cleanup = await Promise.allSettled([
      closeHttpServer(secondServer),
      tracker.terminateAll(),
    ]);
    await rm(temp, { recursive: true, force: true });
    const failed = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
});
