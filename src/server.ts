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
import { parseDropHost, contentRootDomain } from '@/lib/dropHost';

export type HostKind = 'app' | 'content' | 'drop' | 'unknown';

declare module 'fastify' {
  interface FastifyRequest {
    hostKind: HostKind;
    dropHost?: { username: string; dropname: string; hostname: string };
  }
}

export interface BuildOptions {
  loggerStream?: NodeJS.WritableStream;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const logger = opts.loggerStream
    ? { level: 'info' as const, stream: opts.loggerStream }
    : { level: config.LOG_LEVEL === 'silent' ? 'silent' : config.LOG_LEVEL };
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 110 * 1024 * 1024,
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'request_id',
    requestIdHeader: false,
  });

  await app.register(cookies, { secret: config.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart, {
    preservePath: true,
    limits: { fieldNameSize: 200, fieldSize: 1024 },
  });
  await app.register(view, { engine: { ejs }, root: 'src/views' });

  app.decorateRequest('hostKind', 'unknown');
  app.decorateRequest('dropHost', undefined);
  app.addHook('onRequest', async (req) => {
    const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    const appHost = new URL(config.APP_ORIGIN).hostname.toLowerCase();
    const contentApex = contentRootDomain();
    if (host === appHost) { req.hostKind = 'app'; return; }
    if (host === contentApex) { req.hostKind = 'content'; return; }
    const parsed = parseDropHost(host);
    if (parsed) {
      req.hostKind = 'drop';
      req.dropHost = { ...parsed, hostname: host };
      return;
    }
    req.hostKind = 'unknown';
  });

  const { healthRoute } = await import('@/routes/health');
  await app.register(healthRoute);

  return app;
}
