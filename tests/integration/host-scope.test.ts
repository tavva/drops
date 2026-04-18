import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '@/server';
import { onAppHost, onContentHost } from '@/middleware/host';

const app = await buildServer();
await app.register(onAppHost(async (s) => { s.get('/app-only', async () => 'app'); }));
await app.register(onContentHost(async (s) => { s.get('/content-only', async () => 'content'); }));
afterAll(async () => { await app.close(); });

describe('host scoping', () => {
  it('app-only route rejects content host', async () => {
    const ok = await app.inject({ method: 'GET', url: '/app-only', headers: { host: 'drops.localtest.me' } });
    expect(ok.statusCode).toBe(200);
    const ko = await app.inject({ method: 'GET', url: '/app-only', headers: { host: 'content.localtest.me' } });
    expect(ko.statusCode).toBe(404);
  });

  it('content-only route rejects app host', async () => {
    const ok = await app.inject({ method: 'GET', url: '/content-only', headers: { host: 'content.localtest.me' } });
    expect(ok.statusCode).toBe(200);
    const ko = await app.inject({ method: 'GET', url: '/content-only', headers: { host: 'drops.localtest.me' } });
    expect(ko.statusCode).toBe(404);
  });

  it('unknown host rejects either scoped route', async () => {
    const a = await app.inject({ method: 'GET', url: '/app-only', headers: { host: 'evil.example' } });
    expect(a.statusCode).toBe(404);
    const b = await app.inject({ method: 'GET', url: '/content-only', headers: { host: 'evil.example' } });
    expect(b.statusCode).toBe(404);
  });
});
