// ABOUTME: Fastify hooks that issue and validate CSRF tokens on the app host.
// ABOUTME: Tokens are rotated on every GET render; POST/PUT/PATCH/DELETE must include a matching token.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken, verifyCsrfToken, originMatches } from '@/lib/csrf';
import { appCookieOptions, verifyCookie } from '@/lib/cookies';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { config } from '@/config';

declare module 'fastify' {
  interface FastifyRequest {
    pendingLogin?: { id: string };
    csrfToken?: string;
  }
  interface FastifyContextConfig {
    skipCsrf?: boolean;
  }
}

function sessionIdFromCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[APP_SESSION_COOKIE];
  if (!raw) return null;
  return verifyCookie(raw, config.SESSION_SECRET);
}

function contextId(req: FastifyRequest): string | null {
  return req.session?.id ?? req.pendingLogin?.id ?? sessionIdFromCookie(req);
}

export async function registerCsrf(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET') return;
    const ctx = contextId(req);
    if (!ctx) return;
    const token = issueCsrfToken(ctx);
    reply.setCookie(CSRF_COOKIE, token, appCookieOptions({ httpOnly: false }));
    req.csrfToken = token;
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (req.routeOptions.config?.skipCsrf) return;

    const headerOrigin = (req.headers.origin as string | undefined)
      ?? (req.headers.referer as string | undefined);
    if (!originMatches(headerOrigin)) return badOrigin(reply);

    const cookie = req.cookies[CSRF_COOKIE] ?? '';
    const submitted = (req.headers[CSRF_HEADER] as string | undefined)
      ?? (req.body as Record<string, string> | undefined)?._csrf
      ?? '';
    if (!cookie || !submitted || cookie !== submitted) return badCsrf(reply);

    const ctx = contextId(req);
    if (!ctx) return reply.code(403).send('no_csrf_context');
    if (!verifyCsrfToken(ctx, submitted)) return badCsrf(reply);
  });
}

function badOrigin(reply: FastifyReply) { reply.code(403).send('bad_origin'); }
function badCsrf(reply: FastifyReply) { reply.code(403).send('bad_csrf'); }
