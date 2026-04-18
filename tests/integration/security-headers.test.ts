import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost, onContentHost } = await import('@/middleware/host');
  const { registerAppSecurity, registerContentSecurity } = await import('@/middleware/security');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerAppSecurity(s);
    s.get('/app', async () => 'ok');
  }));
  await appInstance.register(onContentHost(async (s) => {
    await registerContentSecurity(s);
    s.get('/alice/site/', async () => 'ok');
  }));
});

afterAll(async () => { await appInstance.close(); });

describe('security headers', () => {
  it('app host sets a strict CSP', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/app', headers: { host: 'drops.localtest.me' },
    });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']?.toString().toLowerCase()).toBe('deny');
  });

  it('content host omits CSP', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site/', headers: { host: 'content.localtest.me' },
    });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
