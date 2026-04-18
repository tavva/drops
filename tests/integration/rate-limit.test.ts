import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerRateLimit, tightAuthLimit } = await import('@/middleware/rateLimit');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerRateLimit(s);
    s.get('/auth/login', { config: tightAuthLimit }, async () => 'ok');
  }));
});

afterAll(async () => { await appInstance.close(); });

describe('rate limiter', () => {
  it('returns 429 after exceeding the auth-route limit', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const res = await appInstance.inject({
        method: 'GET', url: '/auth/login',
        headers: { host: 'drops.localtest.me', 'x-forwarded-for': '1.2.3.4' },
      });
      last = res.statusCode;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
