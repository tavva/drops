// ABOUTME: Verifies secure PKCE generation, loopback callback validation, and browser launching.
// ABOUTME: Keeps browser and timing effects injectable so the authentication flow is deterministic.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  buildAuthorizeUrl,
  createDeviceLabel,
  createPkce,
  openMacOsBrowser,
  waitForBrowserAuthorization,
} from '../src/auth.js';

function get(url: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers: options.host === undefined ? {} : { host: options.host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

describe('PKCE and authorisation URL', () => {
  it('creates a verifier with at least 256 bits and its S256 base64url challenge', () => {
    const first = createPkce();
    const second = createPkce();

    expect(Buffer.from(first.verifier, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    expect(Buffer.from(first.state, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(first.challenge).toBe(createHash('sha256').update(first.verifier).digest('base64url'));
  });

  it('builds the exact server authorisation query', () => {
    const result = buildAuthorizeUrl('https://drops.example.com', {
      redirectUri: 'http://127.0.0.1:54321/callback',
      state: 'state-value',
      challenge: 'challenge-value',
    });

    expect(result).toBe(
      'https://drops.example.com/app/cli/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&state=state-value&code_challenge=challenge-value&code_challenge_method=S256',
    );
  });
});

describe('loopback browser authorisation', () => {
  it('binds in the private dynamic range and accepts only the exact callback, state, and host', async () => {
    let opened = '';
    const pending = waitForBrowserAuthorization({
      origin: 'https://drops.example.com',
      state: 'expected-state',
      challenge: 'challenge',
      timeoutMs: 2_000,
      portCandidates: [50_123],
      openBrowser: async (url) => {
        opened = url;
      },
    });
    await vi.waitFor(() => expect(opened).not.toBe(''));

    const redirect = new URL(new URL(opened).searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThanOrEqual(49_152);
    expect(Number(redirect.port)).toBeLessThanOrEqual(65_535);

    await expect(get(`${redirect.origin}/other?state=expected-state&code=secret-code`)).resolves.toMatchObject({ status: 404 });
    await expect(get(`${redirect.href}?state=expected-state&code=secret-code`, { method: 'POST' })).resolves.toMatchObject({ status: 405 });
    await expect(get(`${redirect.href}?state=expected-state&code=secret-code`, { host: 'localhost:50123' })).resolves.toMatchObject({ status: 400 });

    const completion = get(`${redirect.href}?state=expected-state&code=one-time-code`);
    await expect(pending).resolves.toEqual({
      code: 'one-time-code',
      redirectUri: 'http://127.0.0.1:50123/callback',
    });
    await expect(completion).resolves.toMatchObject({ status: 200 });
    await expect(get(`${redirect.href}?state=expected-state&code=again`)).rejects.toThrow();
  });

  it.each([
    ['state mismatch', '?state=wrong&code=secret-code'],
    ['missing code', '?state=expected-state'],
    ['browser denial', '?state=expected-state&error=access_denied'],
  ])('denies %s without including callback secrets in the error', async (_name, query) => {
    let redirectUri = '';
    const pending = waitForBrowserAuthorization({
      origin: 'https://drops.example.com',
      state: 'expected-state',
      challenge: 'challenge',
      timeoutMs: 2_000,
      portCandidates: [50_124],
      openBrowser: async (url) => {
        redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      },
    });
    const settled = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(redirectUri).not.toBe(''));
    await get(`${redirectUri}${query}`);
    const error = await settled;
    expect(error).toMatchObject({ code: 'authorisation_denied', exitCode: 3 });
    expect(JSON.stringify(error)).not.toContain('secret-code');
    await expect(get(`${redirectUri}?state=expected-state&code=again`)).rejects.toThrow();
  });

  it('maps the five-minute timeout to authorisation_denied and closes the listener', async () => {
    let redirectUri = '';
    const pending = waitForBrowserAuthorization({
      origin: 'https://drops.example.com',
      state: 'expected-state',
      challenge: 'challenge',
      timeoutMs: 10,
      portCandidates: [50_125],
      openBrowser: async (url) => {
        redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'authorisation_denied', exitCode: 3 });
    await expect(get(`${redirectUri}?state=expected-state&code=late`)).rejects.toThrow();
  });

  it('retries a busy candidate port and closes the listener when opening the browser fails', async () => {
    let opened = '';
    const first = waitForBrowserAuthorization({
      origin: 'https://drops.example.com',
      state: 'first-state',
      challenge: 'challenge',
      timeoutMs: 2_000,
      portCandidates: [50_126],
      openBrowser: async (url) => {
        opened = new URL(url).searchParams.get('redirect_uri')!;
      },
    });
    const firstSettled = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(opened).not.toBe(''));

    const failed = waitForBrowserAuthorization({
      origin: 'https://drops.example.com',
      state: 'second-state',
      challenge: 'challenge',
      timeoutMs: 2_000,
      portCandidates: [50_126, 50_127],
      openBrowser: async (url) => {
        expect(new URL(new URL(url).searchParams.get('redirect_uri')!).port).toBe('50127');
        throw new Error('open failed with drops_cli_secret');
      },
    });
    await expect(failed).rejects.toMatchObject({ code: 'authorisation_denied', exitCode: 3 });
    await expect(get('http://127.0.0.1:50127/callback')).rejects.toThrow();

    await get(`${opened}?state=first-state&error=access_denied`);
    await expect(firstSettled).resolves.toMatchObject({ code: 'authorisation_denied' });
  });
});

describe('browser opener and device label', () => {
  it('uses the absolute trusted macOS opener and waits for its spawn event', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      Object.assign(child, { unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await openMacOsBrowser('https://drops.example.com', spawn as never);

    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', ['https://drops.example.com'], expect.any(Object));
  });

  it('sanitises every Unicode control character, caps the full label, and has a nonempty fallback', () => {
    expect(createDeviceLabel(() => 'Ben\u0000s\u0085Mac')).toBe('Drops CLI on BensMac');
    expect(createDeviceLabel(() => 'x'.repeat(200))).toBe(`Drops CLI on ${'x'.repeat(87)}`);
    expect(createDeviceLabel(() => '\u0000\u0085')).toBe('Drops CLI on unknown host');
  });
});
