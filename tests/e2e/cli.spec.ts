// ABOUTME: Full-system Playwright coverage for the built CLI against real Drops HTTP, Postgres, and R2.
// ABOUTME: A test-only child harness injects file credentials/browser opening; production has no test backdoor.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

type CliResult = { exitCode: number; stdout: string; stderr: string };

function runCli(
  args: string[],
  options: { cwd: string; credentials: string; openedUrl: string },
): Promise<CliResult> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [
      resolve('tests/e2e/helpers/cli-child.mjs'),
      ...args,
    ], {
      cwd: options.cwd,
      env: {
        ...process.env,
        DROPS_CLI_TEST_CREDENTIALS: options.credentials,
        DROPS_CLI_TEST_OPENED_URL: options.openedUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolveChild({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
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

function startFullServer(): Promise<ChildProcess> {
  return new Promise((resolveServer, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/e2e/helpers/full-server.ts')], {
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
    const timeout = setTimeout(() => reject(new Error(`Drops test server timed out: ${stdout} ${stderr}`)), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('READY\n')) {
        clearTimeout(timeout);
        resolveServer(child);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!stdout.includes('READY\n')) {
        clearTimeout(timeout);
        reject(new Error(`Drops test server exited ${code}: ${stdout} ${stderr}`));
      }
    });
  });
}

function parseJson(result: CliResult): Record<string, unknown> {
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
}

test('login, configure, deploy, serve, select instances, and revoke CLI access', async ({ request }) => {
  const temp = await mkdtemp(join(tmpdir(), 'drops-cli-e2e-'));
  const repo = join(temp, 'repo');
  const credentials = join(temp, 'credentials.json');
  const openedUrl = join(temp, 'opened-url');
  let fullServer: ChildProcess | undefined;
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

    fullServer = await startFullServer();

    const csrf = issueCsrfToken(sid);
    const browserCookie = [
      `drops_session=${signCookie(sid, process.env.SESSION_SECRET!)}`,
      `drops_csrf=${csrf}`,
    ].join('; ');

    const loginPromise = runCli(['login', APP_ORIGIN, '--json'], { cwd: repo, credentials, openedUrl });
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

    const init = await runCli(['init', '--instance', APP_ORIGIN, '--json'], { cwd: repo, credentials, openedUrl });
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(repo, '.drops.json'), 'utf8'))).toEqual({ instance: APP_ORIGIN });
    expect(await readFile(join(repo, '.drops.json'), 'utf8')).not.toContain('drops_cli_');

    const deploy = await runCli(['deploy', './site', '--name', 'cli-preview', '--json'], {
      cwd: repo,
      credentials,
      openedUrl,
    });
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

    const status = await runCli(['auth', 'status', '--json'], { cwd: repo, credentials, openedUrl });
    expect(parseJson(status)).toMatchObject({ instance: APP_ORIGIN, authenticated: true });

    // The second instance deliberately implements only v1 discovery/whoami. The full Drops
    // production routes above cover login/deploy/revoke; this boundary keeps Postgres/R2 isolated
    // while proving exact-origin credential keys and --instance precedence from a real child CLI.
    const secondPort = await availablePort();
    const secondOrigin = `http://127.0.0.1:${secondPort}`;
    secondServer = createHttpServer((request, response) => {
      if (request.url === '/.well-known/drops') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ service: 'drops', apiVersion: 1, appOrigin: secondOrigin }));
        return;
      }
      if (request.url === '/api/v1/whoami' && request.headers.authorization === 'Bearer second-token') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'second-user', email: 'second@example.com', username: 'second' }));
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
      { cwd: repo, credentials, openedUrl },
    );
    expect(parseJson(overridden)).toMatchObject({
      instance: secondOrigin,
      authenticated: true,
      user: { username: 'second' },
    });

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

    const revokedStatus = await runCli(['auth', 'status', '--json'], { cwd: repo, credentials, openedUrl });
    expect(revokedStatus.exitCode).toBe(0);
    expect(parseJson(revokedStatus)).toMatchObject({ instance: APP_ORIGIN, authenticated: false, user: null });
    const afterStatus = JSON.parse(await readFile(credentials, 'utf8')) as Record<string, string>;
    expect(afterStatus[APP_ORIGIN]).toBeUndefined();
    expect(afterStatus[secondOrigin]).toBe('second-token');

    const revokedDeploy = await runCli(['deploy', './site', '--name', 'after-revoke', '--json'], {
      cwd: repo,
      credentials,
      openedUrl,
    });
    expect(revokedDeploy.exitCode).toBe(3);
    expect(parseJson(revokedDeploy)).toMatchObject({ error: { code: 'not_authenticated', instance: APP_ORIGIN } });
    expect(`${revokedDeploy.stdout}${revokedDeploy.stderr}`).not.toContain('drops_cli_');

    await db.delete(sessions);
  } finally {
    if (secondServer?.listening) await new Promise<void>((resolveClose) => secondServer!.close(() => resolveClose()));
    await stopChild(fullServer);
    await rm(temp, { recursive: true, force: true });
  }
});
