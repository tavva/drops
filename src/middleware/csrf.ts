// ABOUTME: Fastify hooks that issue and validate CSRF tokens on the app host.
// ABOUTME: Tokens are minted when the cookie is missing or no longer valid for the current context;
// ABOUTME: reusing the existing token keeps static asset GETs from invalidating in-flight form submissions.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CSRF_COOKIE, CSRF_ANON_COOKIE, CSRF_HEADER, issueCsrfToken, verifyCsrfToken, requestOriginOk } from '@/lib/csrf';
import { appCookieOptions, verifyCookie } from '@/lib/cookies';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { STATIC_PREFIX } from '@/routes/app/static';
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

function anonContextId(req: FastifyRequest): string | null {
  const raw = req.cookies[CSRF_ANON_COOKIE];
  if (!raw) return null;
  return verifyCookie(raw, config.SESSION_SECRET);
}

function contextId(req: FastifyRequest): string | null {
  return req.session?.id ?? req.pendingLogin?.id ?? sessionIdFromCookie(req) ?? anonContextId(req);
}

export async function registerCsrf(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET') return;
    // Static assets never render a form and must not rebind drops_csrf. A page loaded during the
    // pending-login window (choose-username) pulls its stylesheet without the path=/auth pending
    // cookie, so the only context here would be a stale csrf_anon — rebinding to it breaks the
    // form's token. Skip issuance entirely for these.
    if (req.url.startsWith(STATIC_PREFIX)) return;
    const ctx = contextId(req);
    if (!ctx) return;
    const existing = req.cookies[CSRF_COOKIE];
    if (existing && verifyCsrfToken(ctx, existing)) {
      req.csrfToken = existing;
      return;
    }
    const token = issueCsrfToken(ctx);
    reply.setCookie(CSRF_COOKIE, token, appCookieOptions({ httpOnly: false }));
    req.csrfToken = token;
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (req.routeOptions.config?.skipCsrf) return;

    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    if (!requestOriginOk(origin, referer)) return badOrigin(reply);

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
