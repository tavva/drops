// ABOUTME: requireAppSession / requireContentSession preHandlers.
// ABOUTME: On miss, redirects to the app-host /auth/login with ?next= URL-encoded.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser, rollIfStale } from '@/services/sessions';
import { verifyCookie, appCookieOptions, contentCookieOptions } from '@/lib/cookies';
import { config } from '@/config';

export const APP_SESSION_COOKIE = 'drops_session';
export const CONTENT_SESSION_COOKIE = 'drops_content_session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; username: string; name: string | null; avatarUrl: string | null };
    session?: { id: string };
  }
}

function currentUrl(req: FastifyRequest, origin: string): string {
  return new URL(req.raw.url ?? '/', origin).toString();
}

function loginRedirect(reply: FastifyReply, nextUrl: string): FastifyReply {
  const target = new URL('/auth/login', config.APP_ORIGIN);
  target.searchParams.set('next', nextUrl);
  return reply.redirect(target.toString(), 302);
}

async function loadFromCookie(
  req: FastifyRequest,
  cookieName: string,
): Promise<{ id: string; user: NonNullable<FastifyRequest['user']> } | null> {
  const raw = req.cookies[cookieName];
  if (!raw) return null;
  const sid = verifyCookie(raw, config.SESSION_SECRET);
  if (!sid) return null;
  const found = await getSessionUser(sid);
  if (!found) return null;
  return {
    id: found.session.id,
    user: {
      id: found.user.id,
      email: found.user.email,
      username: found.user.username,
      name: found.user.name,
      avatarUrl: found.user.avatarUrl,
    },
  };
}

export async function requireAppSession(req: FastifyRequest, reply: FastifyReply) {
  const found = await loadFromCookie(req, APP_SESSION_COOKIE);
  if (!found) {
    reply.clearCookie(APP_SESSION_COOKIE, appCookieOptions());
    return loginRedirect(reply, currentUrl(req, config.APP_ORIGIN));
  }
  await rollIfStale(found.id);
  req.session = { id: found.id };
  req.user = found.user;
  req.log = req.log.child({ user_id: found.user.id });
}

export async function requireContentSession(req: FastifyRequest, reply: FastifyReply) {
  const found = await loadFromCookie(req, CONTENT_SESSION_COOKIE);
  if (!found) {
    reply.clearCookie(CONTENT_SESSION_COOKIE, contentCookieOptions());
    return loginRedirect(reply, currentUrl(req, config.CONTENT_ORIGIN));
  }
  await rollIfStale(found.id);
  req.session = { id: found.id };
  req.user = found.user;
  req.log = req.log.child({ user_id: found.user.id });
}
