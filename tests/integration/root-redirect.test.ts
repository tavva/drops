// ABOUTME: Integration test for GET / on the app host — redirects to /app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { rootRoute } = await import('@/routes/app/root');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await s.register(rootRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

describe('GET /', () => {
  it('redirects to /app on the app host', async () => {
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host: 'drops.localtest.me' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app');
  });

  it('404s on the content host', async () => {
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host: 'content.localtest.me' } });
    expect(res.statusCode).toBe(404);
  });
});
