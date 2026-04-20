// ABOUTME: Drop-host GET /auth/bootstrap — consumes a host-bound handoff token, re-checks canView,
// ABOUTME: and sets a Domain-scoped drop-session cookie before redirecting to a same-host path.
import type { FastifyPluginAsync } from 'fastify';
import { verifyHandoff } from '@/lib/handoff';
import { signDropCookie, dropCookieOptions } from '@/lib/cookies';
import { getSessionUser } from '@/services/sessions';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canView } from '@/services/permissions';
import { DROP_SESSION_COOKIE } from '@/middleware/auth';
import { config } from '@/config';

function sameHostPath(raw: string | undefined): string {
  if (!raw) return '/';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/';
}

export const bootstrapRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/bootstrap', { config: { skipCsrf: true } }, async (req, reply) => {
    const parsed = req.dropHost;
    if (!parsed) return reply.code(404).send('not_found');

    const q = req.query as Record<string, string | undefined>;
    const token = q.token ?? '';
    const result = verifyHandoff(token, parsed.hostname, config.SESSION_SECRET);
    if (!result.ok) return reply.code(400).send(`bad_token:${result.reason}`);

    const found = await getSessionUser(result.sessionId);
    if (!found) return reply.code(400).send('session_missing');

    const owner = await findByUsername(parsed.username);
    if (!owner) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(owner.id, parsed.dropname);
    if (!drop) return reply.code(404).send('not_found');

    const allowed = await canView(
      { id: found.user.id, email: found.user.email },
      { id: drop.id, ownerId: drop.ownerId, viewMode: drop.viewMode },
    );
    if (!allowed) return reply.code(403).send('forbidden');

    const value = signDropCookie(result.sessionId, parsed.hostname, config.SESSION_SECRET);
    reply.setCookie(DROP_SESSION_COOKIE, value, dropCookieOptions(parsed.hostname, {
      maxAge: 30 * 24 * 3600,
    }));

    return reply.redirect(sameHostPath(q.next), 302);
  });
};
