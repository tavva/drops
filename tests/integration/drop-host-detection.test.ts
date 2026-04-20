// ABOUTME: Integration tests that req.hostKind detects drop subdomains and onDropHost scopes plugins.
import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '@/server';
import { onAppHost, onContentHost, onDropHost } from '@/middleware/host';

const app = await buildServer();
await app.register(onAppHost(async (s) => { s.get('/app-only', async () => 'app'); }));
await app.register(onContentHost(async (s) => { s.get('/content-only', async () => 'content'); }));
await app.register(onDropHost(async (s) => {
  s.get('/drop-only', async (req) => ({
    hostKind: req.hostKind,
    dropHost: req.dropHost ?? null,
  }));
}));
afterAll(async () => { await app.close(); });

describe('drop host detection', () => {
  it('treats alice--foo.content.localtest.me as a drop host', async () => {
    const res = await app.inject({ method: 'GET', url: '/drop-only', headers: { host: 'alice--foo.content.localtest.me' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hostKind: 'drop',
      dropHost: { username: 'alice', dropname: 'foo', hostname: 'alice--foo.content.localtest.me' },
    });
  });

  it('rejects app host on drop-only route', async () => {
    const res = await app.inject({ method: 'GET', url: '/drop-only', headers: { host: 'drops.localtest.me' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects content apex on drop-only route', async () => {
    const res = await app.inject({ method: 'GET', url: '/drop-only', headers: { host: 'content.localtest.me' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects drop host on content-only route', async () => {
    const res = await app.inject({ method: 'GET', url: '/content-only', headers: { host: 'alice--foo.content.localtest.me' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects malformed drop subdomain on drop-only route', async () => {
    const res = await app.inject({ method: 'GET', url: '/drop-only', headers: { host: 'alice-foo.content.localtest.me' } });
    expect(res.statusCode).toBe(404);
  });
});
