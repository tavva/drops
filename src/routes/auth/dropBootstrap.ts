// ABOUTME: App-host GET /auth/drop-bootstrap?host=…&next=… — mints a host-bound handoff so the
// ABOUTME: browser can establish a session cookie on a specific drop subdomain, then redirects there.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { verifyCookie } from '@/lib/cookies';
import { signHandoff } from '@/lib/handoff';
import { parseDropHost } from '@/lib/dropHost';
import { getSessionUser } from '@/services/sessions';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canView } from '@/services/permissions';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { config } from '@/config';

function normaliseNextPath(raw: string | undefined): string {
  if (!raw) return '/';
  if (raw.startsWith('/')) return raw;
  return '/';
}

async function resolveSession(req: FastifyRequest): Promise<{ sid: string; userId: string; email: string } | null> {
  const raw = req.cookies[APP_SESSION_COOKIE];
  if (!raw) return null;
  const sid = verifyCookie(raw, config.SESSION_SECRET);
  if (!sid) return null;
  const found = await getSessionUser(sid);
  if (!found) return null;
  return { sid, userId: found.user.id, email: found.user.email };
}

function dropHostOrigin(host: string): string {
  const u = new URL(config.CONTENT_ORIGIN);
  u.hostname = host;
  return u.origin;
}

export const dropBootstrapRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/drop-bootstrap', { config: { skipCsrf: true, ...tightAuthLimit } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const host = (q.host ?? '').toLowerCase();
    const parsed = parseDropHost(host);
    if (!parsed) return reply.code(404).send('not_found');

    const nextPath = normaliseNextPath(q.next);

    const session = await resolveSession(req);
    if (!session) {
      const selfUrl = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
      selfUrl.searchParams.set('host', host);
      selfUrl.searchParams.set('next', nextPath);
      const login = new URL('/auth/login', config.APP_ORIGIN);
      login.searchParams.set('next', selfUrl.toString());
      return reply.redirect(login.toString(), 302);
    }

    const owner = await findByUsername(parsed.username);
    if (!owner) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(owner.id, parsed.dropname);
    if (!drop) return reply.code(404).send('not_found');

    const allowed = await canView(
      { id: session.userId, email: session.email },
      { id: drop.id, ownerId: drop.ownerId, viewMode: drop.viewMode },
    );
    if (!allowed) {
      return reply.redirect(new URL('/app', config.APP_ORIGIN).toString(), 302);
    }

    const token = signHandoff(session.sid, host, config.SESSION_SECRET, 60);
    const target = new URL('/auth/bootstrap', dropHostOrigin(host));
    target.searchParams.set('token', token);
    target.searchParams.set('next', nextPath);
    return reply.redirect(target.toString(), 302);
  });
};
