// ABOUTME: GET/POST /auth/choose-username — completes signup for a brand-new user or
// ABOUTME: sets a username for an existing member who doesn't have one yet (promoted viewer).
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { pendingLogins, users } from '@/db/schema';
import { verifyCookie, signCookie, appCookieOptions } from '@/lib/cookies';
import { consumePendingLogin } from '@/services/pendingLogins';
import { createUser, isUsernameTaken, setUsername, UserConflictError } from '@/services/users';
import { createSession, getSessionUser } from '@/services/sessions';
import { signHandoff } from '@/lib/handoff';
import { parseDropHost } from '@/lib/dropHost';
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

type ExistingUser = typeof users.$inferSelect;

type Context =
  | { mode: 'pending'; pending: PendingPayload }
  | { mode: 'existing'; user: ExistingUser; sessionId: string };

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

async function loadExisting(req: FastifyRequest): Promise<{ user: ExistingUser; sessionId: string } | null> {
  const raw = req.cookies[APP_SESSION_COOKIE];
  if (!raw) return null;
  const sid = verifyCookie(raw, config.SESSION_SECRET);
  if (!sid) return null;
  const found = await getSessionUser(sid);
  if (!found) return null;
  if (found.user.kind !== 'member') return null;
  if (found.user.username !== null) return null;
  return { user: found.user, sessionId: sid };
}

async function loadContext(req: FastifyRequest): Promise<Context | null> {
  const pending = await loadPending(req);
  if (pending) return { mode: 'pending', pending };
  const existing = await loadExisting(req);
  if (existing) return { mode: 'existing', user: existing.user, sessionId: existing.sessionId };
  return null;
}

function ctxId(ctx: Context): string {
  return ctx.mode === 'pending' ? ctx.pending.id : ctx.sessionId;
}

function ctxEmail(ctx: Context): string {
  return ctx.mode === 'pending' ? ctx.pending.email : ctx.user.email;
}

async function completeSignup(
  reply: import('fastify').FastifyReply,
  sessionId: string,
  nextUrl: string,
): Promise<import('fastify').FastifyReply> {
  try {
    const u = new URL(nextUrl);
    const parsed = parseDropHost(u.hostname);
    if (parsed) {
      const token = signHandoff(sessionId, u.hostname.toLowerCase(), config.SESSION_SECRET, 60);
      const bootstrap = new URL('/auth/bootstrap', u.origin);
      bootstrap.searchParams.set('token', token);
      bootstrap.searchParams.set('next', (u.pathname + u.search) || '/');
      return reply.redirect(bootstrap.toString(), 302);
    }
  } catch { /* fall through */ }
  return reply.redirect(nextUrl, 302);
}

export const chooseUsernameRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/choose-username', async (req, reply) => {
    const ctx = await loadContext(req);
    if (!ctx) return reply.redirect(new URL('/auth/login', config.APP_ORIGIN).toString(), 302);
    const q = req.query as Record<string, string | undefined>;
    const next = allowedNext(q.next);
    const csrfToken = issueCsrfToken(ctxId(ctx));
    reply.setCookie(CSRF_COOKIE, csrfToken, appCookieOptions({ httpOnly: false }));
    return reply.view('chooseUsername.ejs', {
      email: ctxEmail(ctx),
      suggested: suggestSlug(ctxEmail(ctx)),
      next,
      csrfToken,
      error: null,
      contentOrigin: config.CONTENT_ORIGIN,
    });
  });

  app.post('/auth/choose-username', { config: { skipCsrf: true } }, async (req, reply) => {
    const ctx = await loadContext(req);
    if (!ctx) return reply.redirect(new URL('/auth/login', config.APP_ORIGIN).toString(), 302);

    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    if (!requestOriginOk(origin, referer)) return reply.code(403).send('bad_origin');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const cookieCsrf = req.cookies[CSRF_COOKIE] ?? '';
    const submitted = body._csrf ?? '';
    if (!cookieCsrf || !submitted || cookieCsrf !== submitted) return reply.code(403).send('bad_csrf');
    if (!verifyCsrfToken(ctxId(ctx), submitted)) return reply.code(403).send('bad_csrf');

    const username = (body.username ?? '').trim();
    const next = allowedNext(body.next);

    const rerender = (error: string) => {
      const token = issueCsrfToken(ctxId(ctx));
      reply.setCookie(CSRF_COOKIE, token, appCookieOptions({ httpOnly: false }));
      return reply.code(400).view('chooseUsername.ejs', {
        email: ctxEmail(ctx),
        suggested: username || suggestSlug(ctxEmail(ctx)),
        next,
        csrfToken: token,
        error,
        contentOrigin: config.CONTENT_ORIGIN,
      });
    };

    if (!isValidSlug(username)) return rerender('Username must be 2–32 chars, a-z, 0-9, and hyphens, starting and ending with a letter or digit.');
    if (RESERVED_USERNAMES.has(username)) return rerender('That username is reserved.');
    if (await isUsernameTaken(username)) return rerender('That username is taken.');

    try {
      if (ctx.mode === 'pending') {
        const user = await createUser({
          email: ctx.pending.email,
          username,
          name: ctx.pending.name,
          avatarUrl: ctx.pending.avatarUrl,
        });
        await consumePendingLogin(ctx.pending.id);
        reply.clearCookie(PENDING_LOGIN_COOKIE, appCookieOptions({ path: '/auth' }));

        const sid = await createSession(user.id);
        reply.setCookie(APP_SESSION_COOKIE, signCookie(sid, config.SESSION_SECRET), appCookieOptions({
          maxAge: 30 * 24 * 3600,
        }));
        return completeSignup(reply, sid, next);
      }

      await setUsername(ctx.user.id, username);
      return completeSignup(reply, ctx.sessionId, next);
    } catch (e) {
      if (e instanceof UserConflictError) return rerender(`That ${e.field} is taken.`);
      throw e;
    }
  });
};
