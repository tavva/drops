import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signCookie, verifyCookie } from '@/lib/cookies';

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
