// ABOUTME: Implements PKCE, a loopback callback listener, safe browser opening, and device labels.
// ABOUTME: Keeps authorisation secrets ephemeral and closes the listener on every terminal outcome.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { hostname as osHostname } from 'node:os';

import {
  DropsApiClient,
  type DropsTokenExchange,
  type DropsUser,
  type ExchangeCodeOptions,
  type RevokeCurrentTokenResult,
} from './api.js';
import { DropsCliError } from './errors.js';
import { canonicaliseInstance, resolveInstance } from './instance.js';
import { MacOsKeychainStore, type CredentialStore } from './keychain.js';

const LOOPBACK_HOST = '127.0.0.1';
const MIN_DYNAMIC_PORT = 49_152;
const MAX_DYNAMIC_PORT = 65_535;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const PORT_ATTEMPTS = 32;

export interface PkceValues {
  verifier: string;
  challenge: string;
  state: string;
}

export interface AuthorizeUrlOptions {
  redirectUri: string;
  state: string;
  challenge: string;
}

export interface BrowserAuthorizationResult {
  code: string;
  redirectUri: string;
}

export type BrowserOpener = (url: string) => Promise<void>;

interface SpawnedBrowser {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref?(): void;
}

export type BrowserSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
) => SpawnedBrowser;

export interface WaitForBrowserAuthorizationOptions {
  origin: string;
  state: string;
  challenge: string;
  openBrowser?: BrowserOpener;
  timeoutMs?: number;
  portCandidates?: number[];
}

export interface BrowserLoginResult extends BrowserAuthorizationResult {
  verifier: string;
}

export interface AuthApi {
  discover(origin: string): Promise<unknown>;
  exchangeCode(options: ExchangeCodeOptions): Promise<DropsTokenExchange>;
  revokeCurrentToken(origin: string, token: string): Promise<RevokeCurrentTokenResult>;
  whoami(origin: string, token: string): Promise<DropsUser>;
}

export interface AuthDependencies {
  api: AuthApi;
  store: CredentialStore;
  browserAuthorize(origin: string): Promise<BrowserLoginResult>;
  hostname: () => string;
  resolveInstance?: typeof resolveInstance;
}

export interface LoginOptions {
  origin: string;
  onBrowserOpen?: () => void;
}

export interface ResolvedAuthOptions {
  cwd: string;
  instance?: string;
}

export interface LoginResult {
  instance: string;
  user: DropsUser;
}

export interface LogoutResult {
  instance: string;
  revoked: true;
}

export type AuthStatusResult =
  | { instance: string; authenticated: true; user: DropsUser }
  | { instance: string; authenticated: false; user: null };

function denied(message = 'Browser authorisation was denied'): DropsCliError {
  return new DropsCliError({ code: 'authorisation_denied', message, exitCode: 3 });
}

export function createPkce(): PkceValues {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
  };
}

export function buildAuthorizeUrl(origin: string, options: AuthorizeUrlOptions): string {
  const url = new URL('/app/cli/authorize', origin);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

export function createDeviceLabel(hostname: () => string): string {
  const cleanHostname = hostname().replace(/\p{Cc}/gu, '');
  const suffix = cleanHostname.length === 0 ? 'unknown host' : cleanHostname;
  return `Drops CLI on ${suffix}`.slice(0, 100);
}

export const openMacOsBrowser = (
  url: string,
  spawnBrowser: BrowserSpawn = spawn as BrowserSpawn,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let child: SpawnedBrowser;
    try {
      child = spawnBrowser('/usr/bin/open', [url], { detached: true, stdio: 'ignore' });
    } catch {
      reject(denied('Could not open the browser for authorisation'));
      return;
    }
    child.once('error', () => reject(denied('Could not open the browser for authorisation')));
    child.once('spawn', () => {
      child.unref?.();
      resolve();
    });
  });

function defaultPortCandidates(): number[] {
  const ports = new Set<number>();
  while (ports.size < PORT_ATTEMPTS) ports.add(randomInt(MIN_DYNAMIC_PORT, MAX_DYNAMIC_PORT + 1));
  return [...ports];
}

async function listenOnCandidate(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function waitForBrowserAuthorization(
  options: WaitForBrowserAuthorizationOptions,
): Promise<BrowserAuthorizationResult> {
  const opener = options.openBrowser ?? openMacOsBrowser;
  const candidates = options.portCandidates ?? defaultPortCandidates();
  if (
    candidates.length === 0 ||
    candidates.some((port) => !Number.isInteger(port) || port < MIN_DYNAMIC_PORT || port > MAX_DYNAMIC_PORT)
  ) {
    throw denied('Could not start the local authorisation callback');
  }

  let expectedHost = '';
  let redirectUri = '';
  let settle: ((result: BrowserAuthorizationResult) => void) | undefined;
  let rejectResult: ((error: DropsCliError) => void) | undefined;
  const result = new Promise<BrowserAuthorizationResult>((resolve, reject) => {
    settle = resolve;
    rejectResult = reject;
  });
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const server = createServer((request, response) => {
    if (request.url === undefined || request.headers.host !== expectedHost) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid callback request');
      return;
    }
    const requestUrl = new URL(request.url, redirectUri);
    if (requestUrl.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' }).end('Method not allowed');
      return;
    }

    const finish = (error?: DropsCliError, code?: string) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      response.once('finish', () => {
        void closeServer(server).then(() => {
          if (error !== undefined) rejectResult!(error);
          else settle!({ code: code!, redirectUri });
        });
      });
    };
    const state = requestUrl.searchParams.get('state');
    if (state !== options.state) {
      finish(denied('The browser returned an invalid authorisation response'));
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid authorisation response');
      return;
    }
    if (requestUrl.searchParams.get('error') === 'access_denied') {
      finish(denied());
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorisation denied. You may close this window.');
      return;
    }
    const code = requestUrl.searchParams.get('code');
    if (code === null || code.length === 0) {
      finish(denied('The browser returned an invalid authorisation response'));
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid authorisation response');
      return;
    }
    finish(undefined, code);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorisation complete. You may close this window.');
  });

  try {
    let port: number | undefined;
    for (const candidate of candidates) {
      if (await listenOnCandidate(server, candidate)) {
        port = candidate;
        break;
      }
    }
    if (port === undefined) throw denied('Could not start the local authorisation callback');
    expectedHost = `${LOOPBACK_HOST}:${port}`;
    redirectUri = `http://${expectedHost}/callback`;
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      void closeServer(server).then(() => rejectResult!(denied('Browser authorisation timed out')));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await opener(buildAuthorizeUrl(options.origin, {
      redirectUri,
      state: options.state,
      challenge: options.challenge,
    }));
    return await result;
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    finished = true;
    await closeServer(server);
    if (error instanceof DropsCliError) throw error;
    throw denied('Could not open the browser for authorisation');
  }
}

export function createAuthDependencies(openBrowser: BrowserOpener = openMacOsBrowser): AuthDependencies {
  return {
    api: new DropsApiClient(),
    store: new MacOsKeychainStore(),
    hostname: osHostname,
    resolveInstance,
    async browserAuthorize(origin) {
      const pkce = createPkce();
      const result = await waitForBrowserAuthorization({
        origin,
        state: pkce.state,
        challenge: pkce.challenge,
        openBrowser,
      });
      return { ...result, verifier: pkce.verifier };
    },
  };
}

function revocationFailed(origin: string): DropsCliError {
  return new DropsCliError({
    code: 'revocation_failed',
    message: `Could not confirm token revocation. Please retry, or revoke it from the dashboard at ${origin}`,
    instance: origin,
    exitCode: 3,
  });
}

async function revokeStoredToken(origin: string, token: string, dependencies: AuthDependencies): Promise<void> {
  try {
    await dependencies.api.revokeCurrentToken(origin, token);
  } catch {
    throw revocationFailed(origin);
  }
  await dependencies.store.delete(origin);
}

export async function login(
  options: LoginOptions,
  dependencies: AuthDependencies = createAuthDependencies(),
): Promise<LoginResult> {
  const origin = canonicaliseInstance(options.origin);
  await dependencies.api.discover(origin);

  const existing = await dependencies.store.get(origin);
  if (existing !== null) await revokeStoredToken(origin, existing, dependencies);

  options.onBrowserOpen?.();
  const approval = await dependencies.browserAuthorize(origin);
  const issued = await dependencies.api.exchangeCode({
    origin,
    code: approval.code,
    verifier: approval.verifier,
    redirectUri: approval.redirectUri,
    label: createDeviceLabel(dependencies.hostname),
  });
  try {
    await dependencies.store.set(origin, issued.token);
  } catch (storageError) {
    try {
      await dependencies.api.revokeCurrentToken(origin, issued.token);
    } catch {
      throw new DropsCliError({
        code: 'keychain_unavailable',
        message: `Could not store the credential or confirm cleanup. Revoke it from the dashboard at ${origin}`,
        instance: origin,
        exitCode: 3,
      });
    }
    if (storageError instanceof DropsCliError) throw storageError;
    throw new DropsCliError({
      code: 'keychain_unavailable',
      message: 'macOS Keychain is unavailable',
      instance: origin,
      exitCode: 3,
    });
  }
  return { instance: origin, user: issued.user };
}

export async function logout(
  options: ResolvedAuthOptions,
  dependencies: AuthDependencies = createAuthDependencies(),
): Promise<LogoutResult> {
  const origin = await (dependencies.resolveInstance ?? resolveInstance)({
    cwd: options.cwd,
    explicit: options.instance,
  });
  const token = await dependencies.store.get(origin);
  if (token !== null) await revokeStoredToken(origin, token, dependencies);
  return { instance: origin, revoked: true };
}

export async function authStatus(
  options: ResolvedAuthOptions,
  dependencies: AuthDependencies = createAuthDependencies(),
): Promise<AuthStatusResult> {
  const origin = await (dependencies.resolveInstance ?? resolveInstance)({
    cwd: options.cwd,
    explicit: options.instance,
  });
  const token = await dependencies.store.get(origin);
  if (token === null) return { instance: origin, authenticated: false, user: null };
  try {
    const user = await dependencies.api.whoami(origin, token);
    return { instance: origin, authenticated: true, user };
  } catch (error) {
    if (error instanceof DropsCliError && error.code === 'not_authenticated') {
      await dependencies.store.delete(origin);
      return { instance: origin, authenticated: false, user: null };
    }
    throw error;
  }
}
