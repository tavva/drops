// ABOUTME: Builds the Fastify instance with all shared plugins, host detection, and route registration.
// ABOUTME: Route modules are injected in later tasks via onAppHost / onContentHost plugin wrappers.
import Fastify, { FastifyInstance } from 'fastify';
import cookies from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import view from '@fastify/view';
import ejs from 'ejs';
import { randomUUID } from 'node:crypto';
import { config } from '@/config';

export type HostKind = 'app' | 'content' | 'unknown';

declare module 'fastify' {
  interface FastifyRequest {
    hostKind: HostKind;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL === 'silent' ? 'silent' : config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 110 * 1024 * 1024,
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'request_id',
    requestIdHeader: false,
  });

  await app.register(cookies, { secret: config.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart, { limits: { fieldNameSize: 200, fieldSize: 1024 } });
  await app.register(view, { engine: { ejs }, root: 'src/views' });

  app.decorateRequest('hostKind', 'unknown');
  app.addHook('onRequest', async (req) => {
    const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    const appHost = new URL(config.APP_ORIGIN).hostname.toLowerCase();
    const contentHost = new URL(config.CONTENT_ORIGIN).hostname.toLowerCase();
    if (host === appHost) req.hostKind = 'app';
    else if (host === contentHost) req.hostKind = 'content';
    else req.hostKind = 'unknown';
  });

  app.get('/health', async () => ({ ok: true }));

  return app;
}
