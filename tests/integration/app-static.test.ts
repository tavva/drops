import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { appStaticRoute } = await import('@/routes/app/static');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(appStaticRoute));
});

afterAll(async () => { await appInstance.close(); });

describe('/app/static', () => {
  it('serves the upload client script', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/app/static/new-drop.js',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });
});
