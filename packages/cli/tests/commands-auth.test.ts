// ABOUTME: Verifies login, logout, and auth-status lifecycle ordering and stable CLI output.
// ABOUTME: Uses in-memory API and credential seams so ordinary tests never mutate Keychain or open a browser.
import { describe, expect, it, vi } from 'vitest';

import type { DropsUser, RevokeCurrentTokenResult } from '../src/api.js';
import {
  authStatus,
  login,
  logout,
  type AuthApi,
  type AuthDependencies,
} from '../src/auth.js';
import { parseAuthStatusArguments } from '../src/commands/authStatus.js';
import { parseLoginArguments } from '../src/commands/login.js';
import { parseLogoutArguments } from '../src/commands/logout.js';
import { DropsCliError } from '../src/errors.js';
import { runCli } from '../src/index.js';
import type { CredentialStore } from '../src/keychain.js';

const ORIGIN = 'https://drops.example.com';
const AUTHORIZE_URL = `${ORIGIN}/app/cli/authorize?state=copy-me`;
const USER: DropsUser = { id: 'user-1', email: 'user@example.com', username: 'alice' };

function commandError(code: string, exitCode: 3 | 5 | 6): DropsCliError {
  return new DropsCliError({ code, message: `failed with drops_cli_secret`, instance: ORIGIN, exitCode });
}

function dependencies(options: {
  stored?: string | null;
  revoke?: RevokeCurrentTokenResult | Error;
  setError?: Error;
  deleteError?: Error;
  whoami?: DropsUser | Error;
  exchangeToken?: string;
} = {}): { dependencies: AuthDependencies; order: string[]; store: CredentialStore; api: AuthApi } {
  const order: string[] = [];
  let stored = options.stored ?? null;
  const store: CredentialStore = {
    get: vi.fn(async () => {
      order.push('get');
      return stored;
    }),
    set: vi.fn(async (_origin, token) => {
      order.push(`set:${token}`);
      if (options.setError) throw options.setError;
      stored = token;
    }),
    delete: vi.fn(async () => {
      order.push('delete');
      if (options.deleteError) throw options.deleteError;
      stored = null;
    }),
  };
  const api: AuthApi = {
    discover: vi.fn(async () => {
      order.push('discover');
      return {};
    }),
    exchangeCode: vi.fn(async (request) => {
      order.push(`exchange:${request.code}:${request.verifier}:${request.redirectUri}:${request.label}`);
      return { token: options.exchangeToken ?? 'drops_cli_new', user: USER };
    }),
    revokeCurrentToken: vi.fn(async (_origin, token) => {
      order.push(`revoke:${token}`);
      if (options.revoke instanceof Error) throw options.revoke;
      return options.revoke ?? { status: 'revoked' };
    }),
    whoami: vi.fn(async () => {
      order.push('whoami');
      if (options.whoami instanceof Error) throw options.whoami;
      return options.whoami ?? USER;
    }),
  };
  return {
    order,
    store,
    api,
    dependencies: {
      api,
      store,
      browserAuthorize: vi.fn(async (_origin, onAuthorizeUrl) => {
        order.push('browser');
        onAuthorizeUrl?.(AUTHORIZE_URL);
        return { code: 'auth-code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:50123/callback' };
      }),
      hostname: () => 'Ben\u0000s-Mac',
    },
  };
}

describe('login orchestration', () => {
  it('canonicalises, discovers, authorises, exchanges, labels, and stores in order', async () => {
    const fixture = dependencies();

    await expect(login({ origin: 'HTTPS://Drops.Example.com/' }, fixture.dependencies)).resolves.toEqual({
      instance: ORIGIN,
      user: USER,
    });
    expect(fixture.order).toEqual([
      'discover',
      'get',
      'browser',
      'exchange:auth-code:verifier:http://127.0.0.1:50123/callback:Drops CLI on Bens-Mac',
      'set:drops_cli_new',
    ]);
  });

  it.each([{ status: 'revoked' }, { status: 'already_invalid' }] as RevokeCurrentTokenResult[])(
    'revokes an existing credential before deleting it and opening the browser: $status',
    async (revoke) => {
      const fixture = dependencies({ stored: 'drops_cli_old', revoke });
      await login({ origin: ORIGIN }, fixture.dependencies);
      expect(fixture.order.slice(0, 5)).toEqual(['discover', 'get', 'revoke:drops_cli_old', 'delete', 'browser']);
    },
  );

  it('retains an existing credential and aborts when revocation is uncertain', async () => {
    const fixture = dependencies({ stored: 'drops_cli_old', revoke: commandError('network_error', 5) });

    await expect(login({ origin: ORIGIN }, fixture.dependencies)).rejects.toMatchObject({
      code: 'revocation_failed',
      exitCode: 3,
    });
    expect(fixture.order).toEqual(['discover', 'get', 'revoke:drops_cli_old']);
  });

  it('best-effort revokes a newly issued token when Keychain storage fails', async () => {
    const keychainFailure = new DropsCliError({ code: 'keychain_unavailable', message: 'Keychain unavailable', exitCode: 3 });
    const fixture = dependencies({ setError: keychainFailure });

    await expect(login({ origin: ORIGIN }, fixture.dependencies)).rejects.toBe(keychainFailure);
    expect(fixture.order.slice(-2)).toEqual(['set:drops_cli_new', 'revoke:drops_cli_new']);
  });

  it('reports the dashboard fallback without leaking the new token if cleanup also fails', async () => {
    const fixture = dependencies({
      setError: new Error('set failed drops_cli_new'),
      revoke: commandError('network_error', 5),
    });

    let error: unknown;
    try {
      await login({ origin: ORIGIN }, fixture.dependencies);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'keychain_unavailable', exitCode: 3 });
    expect(String(error)).toContain('dashboard');
    expect(JSON.stringify(error)).not.toContain('drops_cli_new');
  });
});

describe('logout orchestration', () => {
  it('is idempotent without a local credential', async () => {
    const fixture = dependencies();
    await expect(logout({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies)).resolves.toEqual({
      instance: ORIGIN,
      revoked: true,
    });
    expect(fixture.order).toEqual(['get']);
  });

  it.each([{ status: 'revoked' }, { status: 'already_invalid' }] as RevokeCurrentTokenResult[])(
    'deletes locally after server outcome $status',
    async (revoke) => {
      const fixture = dependencies({ stored: 'drops_cli_old', revoke });
      await logout({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies);
      expect(fixture.order).toEqual(['get', 'revoke:drops_cli_old', 'delete']);
    },
  );

  it('retains the local token and returns auth exit 3 on network or server failure', async () => {
    const fixture = dependencies({ stored: 'drops_cli_old', revoke: commandError('network_error', 5) });
    let error: unknown;
    try {
      await logout({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'revocation_failed', exitCode: 3 });
    expect(String(error)).toContain('retry');
    expect(String(error)).toContain('dashboard');
    expect(JSON.stringify(error)).not.toContain('drops_cli_old');
    expect(fixture.order).toEqual(['get', 'revoke:drops_cli_old']);
  });
});

describe('auth status orchestration', () => {
  it('reports missing credentials as an unauthenticated successful state', async () => {
    const fixture = dependencies();
    await expect(authStatus({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies)).resolves.toEqual({
      instance: ORIGIN,
      authenticated: false,
      user: null,
    });
  });

  it('reports the current user for a valid token', async () => {
    const fixture = dependencies({ stored: 'drops_cli_valid' });
    await expect(authStatus({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies)).resolves.toEqual({
      instance: ORIGIN,
      authenticated: true,
      user: USER,
    });
  });

  it('removes a server-invalid 401 credential and reports unauthenticated', async () => {
    const fixture = dependencies({ stored: 'drops_cli_stale', whoami: commandError('not_authenticated', 3) });
    await expect(authStatus({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies)).resolves.toEqual({
      instance: ORIGIN,
      authenticated: false,
      user: null,
    });
    expect(fixture.order).toEqual(['get', 'whoami', 'delete']);
  });

  it('preserves a credential and network exit 5 when the instance is unavailable', async () => {
    const fixture = dependencies({ stored: 'drops_cli_valid', whoami: commandError('network_error', 5) });
    await expect(authStatus({ cwd: '/repo', instance: ORIGIN }, fixture.dependencies)).rejects.toMatchObject({
      code: 'network_error',
      exitCode: 5,
    });
    expect(fixture.order).toEqual(['get', 'whoami']);
  });
});

describe('auth command parsing and output', () => {
  it('accepts the exact command forms and rejects ambiguous or extra origins', () => {
    expect(parseLoginArguments([ORIGIN, '--json'])).toEqual({ origin: ORIGIN, json: true });
    expect(parseLogoutArguments(['--instance', ORIGIN])).toEqual({ instance: ORIGIN, json: false });
    expect(parseAuthStatusArguments([ORIGIN])).toEqual({ instance: ORIGIN, json: false });
    expect(() => parseLoginArguments([])).toThrow(expect.objectContaining({
      message: 'Provide exactly one instance origin.',
      guidance: expect.objectContaining({ usage: 'drops login <origin> [--json]' }),
    }));
    expect(() => parseLogoutArguments([ORIGIN, '--instance', ORIGIN])).toThrow(/either/);
    expect(() => parseAuthStatusArguments([ORIGIN, 'https:\/\/other.example.com'])).toThrow(/at most one/);
    expect(() => parseLogoutArguments(['--instance', ORIGIN, '--instance', ORIGIN])).toThrow(/at most once/);
  });

  it('emits exact JSON and keeps browser progress on stderr', async () => {
    const fixture = dependencies();
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(
      ['login', ORIGIN, '--json'],
      {
        cwd: '/repo',
        stdout: { write: (value) => (stdout += value) },
        stderr: { write: (value) => (stderr += value) },
      },
      undefined,
      { auth: fixture.dependencies },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`${JSON.stringify({ instance: ORIGIN, user: USER })}\n`);
    expect(stderr).toBe(`Authorising in browser…\nOpen this URL if the browser does not open:\n${AUTHORIZE_URL}\n`);
    expect(stdout).not.toContain('Authoris');
    expect(stdout).not.toContain(AUTHORIZE_URL);
  });

  it('emits exact logout and status JSON plus readable human status', async () => {
    const missing = dependencies();
    for (const [argv, expected] of [
      [['logout', '--instance', ORIGIN, '--json'], { instance: ORIGIN, revoked: true }],
      [['auth', 'status', '--instance', ORIGIN, '--json'], { instance: ORIGIN, authenticated: false, user: null }],
    ] as const) {
      let stdout = '';
      const exitCode = await runCli(
        [...argv],
        { cwd: '/repo', stdout: { write: (value) => (stdout += value) }, stderr: { write: () => true } },
        undefined,
        { auth: missing.dependencies },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe(`${JSON.stringify(expected)}\n`);
    }

    let human = '';
    await runCli(
      ['auth', 'status', '--instance', ORIGIN],
      { cwd: '/repo', stdout: { write: (value) => (human += value) }, stderr: { write: () => true } },
      undefined,
      { auth: dependencies({ stored: 'drops_cli_valid' }).dependencies },
    );
    expect(human).toContain(`Authenticated to ${ORIGIN} as alice`);
  });

  it('redacts stored tokens from command errors', async () => {
    const fixture = dependencies({ stored: 'drops_cli_old', revoke: commandError('network_error', 5) });
    let stdout = '';
    const exitCode = await runCli(
      ['logout', '--instance', ORIGIN, '--json'],
      { cwd: '/repo', stdout: { write: (value) => (stdout += value) }, stderr: { write: () => true } },
      undefined,
      { auth: fixture.dependencies },
    );
    expect(exitCode).toBe(3);
    expect(stdout).not.toContain('drops_cli_old');
    expect(JSON.parse(stdout)).toMatchObject({ error: { code: 'revocation_failed', instance: ORIGIN } });
  });
});
