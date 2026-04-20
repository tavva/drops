import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signCookie, verifyCookie, signDropCookie, verifyDropCookie } from '@/lib/cookies';

const key = 'k'.repeat(32);

describe('signCookie/verifyCookie', () => {
  it('round-trips a value', () => {
    const signed = signCookie('hello', key);
    expect(verifyCookie(signed, key)).toBe('hello');
  });
  it('rejects a tampered value', () => {
    const signed = signCookie('hello', key);
    const tampered = 'world' + signed.slice(5);
    expect(verifyCookie(tampered, key)).toBeNull();
  });
  it('rejects a wrong key', () => {
    const signed = signCookie('hello', key);
    expect(verifyCookie(signed, 'x'.repeat(32))).toBeNull();
  });
});

describe('signDropCookie/verifyDropCookie', () => {
  const host = 'alice--foo.content.localtest.me';
  it('round-trips session id when host matches', () => {
    const raw = signDropCookie('sid-123', host, key);
    expect(verifyDropCookie(raw, host, key)).toBe('sid-123');
  });
  it('rejects a cookie minted for a different host', () => {
    const raw = signDropCookie('sid-123', host, key);
    expect(verifyDropCookie(raw, 'bob--bar.content.localtest.me', key)).toBeNull();
  });
  it('rejects a tampered signature', () => {
    const raw = signDropCookie('sid-123', host, key);
    const bad = raw.slice(0, -2) + 'xx';
    expect(verifyDropCookie(bad, host, key)).toBeNull();
  });
  it('rejects a malformed payload', () => {
    expect(verifyDropCookie('no-dot', host, key)).toBeNull();
    expect(verifyDropCookie('a.b', host, key)).toBeNull();
  });
});

describe('dropCookieOptions', () => {
  it('scopes Domain to the exact host', async () => {
    const saved = { ...process.env };
    try {
      process.env = {
        ...saved,
        APP_ORIGIN: 'https://drops.example',
        CONTENT_ORIGIN: 'https://content.example',
      };
      vi.resetModules();
      const mod = await import('@/lib/cookies');
      const opts = mod.dropCookieOptions('alice--foo.content.example');
      expect(opts.domain).toBe('alice--foo.content.example');
      expect(opts.secure).toBe(true);
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
      expect(opts.path).toBe('/');
    } finally { process.env = saved; vi.resetModules(); }
  });
});

describe('cookie options', () => {
  const BASE = {
    DATABASE_URL: 'postgres://u:p@h/db',
    R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd',
    GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs',
    SESSION_SECRET: 'x'.repeat(64),
    ALLOWED_DOMAIN: 'example.com',
  };
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    vi.resetModules();
  });
  afterEach(() => { process.env = saved; });

  it('secure=false for http origin', async () => {
    process.env = { ...BASE, APP_ORIGIN: 'http://localhost:3000', CONTENT_ORIGIN: 'http://localhost:3001' };
    const mod = await import('@/lib/cookies');
    expect(mod.appCookieOptions().secure).toBe(false);
    expect(mod.contentCookieOptions().secure).toBe(false);
  });

  it('secure=true for https origin', async () => {
    process.env = { ...BASE, APP_ORIGIN: 'https://drops.example', CONTENT_ORIGIN: 'https://content.example' };
    const mod = await import('@/lib/cookies');
    expect(mod.appCookieOptions().secure).toBe(true);
    expect(mod.contentCookieOptions().secure).toBe(true);
  });

  it('preserves overrides', async () => {
    process.env = { ...BASE, APP_ORIGIN: 'https://drops.example', CONTENT_ORIGIN: 'https://content.example' };
    const mod = await import('@/lib/cookies');
    expect(mod.appCookieOptions({ maxAge: 60 }).maxAge).toBe(60);
  });
});
