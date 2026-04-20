// ABOUTME: Apex legacy redirect: /:user/:drop[/*] on the content apex 301s to the drop subdomain.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onContentHost } = await import('@/middleware/host');
  const { contentServeRoute } = await import('@/routes/content/serve');
  appInstance = await buildServer();
  await appInstance.register(onContentHost(contentServeRoute));
});

afterAll(async () => { await appInstance.close(); });

describe('apex legacy redirect', () => {
  it('/<user>/<drop> → 301 to <user>--<drop>.<root>/', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('http://alice--site.content.localtest.me:3000/');
  });

  it('/<user>/<drop>/<splat> preserves the splat path', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site/about.html',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('http://alice--site.content.localtest.me:3000/about.html');
  });

  it('preserves query string', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site/a?x=1&y=2',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('http://alice--site.content.localtest.me:3000/a?x=1&y=2');
  });

  it('404s on invalid slug', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/Alice/site/',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(404);
  });
});
