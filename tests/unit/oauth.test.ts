import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('openid-client', () => {
  const Configuration = class {};
  return {
    Configuration,
    discovery: vi.fn(async () => new Configuration()),
    buildAuthorizationUrl: vi.fn((_cfg: unknown, params: Record<string, string>) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return url;
    }),
    authorizationCodeGrant: vi.fn(),
  };
});

describe('buildAuthUrl', () => {
  beforeEach(async () => {
    const mod = await import('@/lib/oauth');
    mod.__resetForTests();
  });

  it('includes scope, state, nonce, response_type, redirect_uri', async () => {
    const { buildAuthUrl } = await import('@/lib/oauth');
    const href = await buildAuthUrl({
      state: 'abc',
      nonce: 'def',
      redirectUri: 'https://drops.example/auth/callback',
    });
    const u = new URL(href);
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('state')).toBe('abc');
    expect(u.searchParams.get('nonce')).toBe('def');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe('https://drops.example/auth/callback');
  });
});
