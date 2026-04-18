// ABOUTME: GET/POST /auth/choose-username — completes signup for a brand-new user.
// ABOUTME: Consumes the pending_login cookie, creates a user + session, hands off to the content origin.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { pendingLogins } from '@/db/schema';
import { verifyCookie, signCookie, appCookieOptions } from '@/lib/cookies';
import { consumePendingLogin } from '@/services/pendingLogins';
import { createUser, isUsernameTaken, UserConflictError } from '@/services/users';
import { createSession } from '@/services/sessions';
import { signHandoff } from '@/lib/handoff';
import { isValidSlug, suggestSlug, RESERVED_USERNAMES } from '@/lib/slug';
import { issueCsrfToken, verifyCsrfToken, requestOriginOk, CSRF_COOKIE } from '@/lib/csrf';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { allowedNext } from './login';
import { PENDING_LOGIN_COOKIE } from './callback';
import { config } from '@/config';

interface PendingPayload {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

async function loadPending(req: FastifyRequest): Promise<PendingPayload | null> {
  const raw = req.cookies[PENDING_LOGIN_COOKIE];
  if (!raw) return null;
  const id = verifyCookie(raw, config.SESSION_SECRET);
  if (!id) return null;
  const rows = await db.select().from(pendingLogins).where(eq(pendingLogins.id, id));
  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return { id, email: row.email, name: row.name, avatarUrl: row.avatarUrl };
}

export const chooseUsernameRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/choose-username', async (req, reply) => {
    const pending = await loadPending(req);
    if (!pending) return reply.redirect(new URL('/auth/login', config.APP_ORIGIN).toString(), 302);
    const q = req.query as Record<string, string | undefined>;
    const next = allowedNext(q.next);
    const csrfToken = issueCsrfToken(pending.id);
    reply.setCookie(CSRF_COOKIE, csrfToken, appCookieOptions({ httpOnly: false }));
    return reply.view('chooseUsername.ejs', {
      email: pending.email,
      suggested: suggestSlug(pending.email),
      next,
      csrfToken,
      error: null,
    });
  });

  app.post('/auth/choose-username', { config: { skipCsrf: true } }, async (req, reply) => {
    const pending = await loadPending(req);
    if (!pending) return reply.redirect(new URL('/auth/login', config.APP_ORIGIN).toString(), 302);

    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    if (!requestOriginOk(origin, referer)) return reply.code(403).send('bad_origin');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const cookieCsrf = req.cookies[CSRF_COOKIE] ?? '';
    const submitted = body._csrf ?? '';
    if (!cookieCsrf || !submitted || cookieCsrf !== submitted) return reply.code(403).send('bad_csrf');
    if (!verifyCsrfToken(pending.id, submitted)) return reply.code(403).send('bad_csrf');

    const username = (body.username ?? '').trim();
    const next = allowedNext(body.next);

    const rerender = (error: string) => reply.code(400).view('chooseUsername.ejs', {
      email: pending.email,
      suggested: username || suggestSlug(pending.email),
      next,
      csrfToken: issueCsrfToken(pending.id),
      error,
    });

    if (!isValidSlug(username)) return rerender('Username must be 2–32 chars, a-z, 0-9, and hyphens, starting and ending with a letter or digit.');
    if (RESERVED_USERNAMES.has(username)) return rerender('That username is reserved.');
    if (await isUsernameTaken(username)) return rerender('That username is taken.');

    try {
      const user = await createUser({
        email: pending.email,
        username,
        name: pending.name,
        avatarUrl: pending.avatarUrl,
      });
      await consumePendingLogin(pending.id);
      reply.clearCookie(PENDING_LOGIN_COOKIE, appCookieOptions({ path: '/auth' }));

      const sid = await createSession(user.id);
      reply.setCookie(APP_SESSION_COOKIE, signCookie(sid, config.SESSION_SECRET), appCookieOptions({
        maxAge: 30 * 24 * 3600,
      }));
      const token = signHandoff(sid, config.SESSION_SECRET, 60);
      const bootstrap = new URL('/auth/bootstrap', config.CONTENT_ORIGIN);
      bootstrap.searchParams.set('token', token);
      bootstrap.searchParams.set('next', next);
      return reply.redirect(bootstrap.toString(), 302);
    } catch (e) {
      if (e instanceof UserConflictError) return rerender(`That ${e.field} is taken.`);
      throw e;
    }
  });
};
