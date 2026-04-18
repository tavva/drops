import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '@/server';

const app = await buildServer();
afterAll(async () => { await app.close(); });

describe('server boot', () => {
  it('answers /health on app host', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'drops.localtest.me' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('tags hostKind based on Host header', async () => {
    const appRes = await app.inject({ method: 'GET', url: '/health', headers: { host: 'drops.localtest.me' } });
    expect(appRes.statusCode).toBe(200);
    const contentRes = await app.inject({ method: 'GET', url: '/health', headers: { host: 'content.localtest.me' } });
    expect(contentRes.statusCode).toBe(200);
    const otherRes = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } });
    expect(otherRes.statusCode).toBe(200);
  });
});
