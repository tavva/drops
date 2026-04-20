// ABOUTME: POST /app/drops/:name/viewers{,/:email/delete} — owner add/remove for drop_viewers.
// ABOUTME: Add is idempotent; bad email re-renders the edit page with a fresh CSRF cookie+token.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { findByOwnerAndName } from '@/services/drops';
import { addViewer, removeViewer, listViewers } from '@/services/dropViewers';
import { isValidSlug } from '@/lib/slug';
import { isLikelyEmail, normaliseEmail } from '@/lib/email';
import { config } from '@/config';
import { formatBytes } from '@/lib/format';
import { dropOriginFor } from '@/lib/dropHost';

export const viewerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/viewers', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(req.user!.id, name);
    if (!drop) return reply.code(404).send('not_found');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const raw = (body.email ?? '').trim();
    const email = normaliseEmail(raw);

    if (!isLikelyEmail(email)) {
      const viewers = await listViewers(drop.id);
      const { issueCsrfToken, CSRF_COOKIE } = await import('@/lib/csrf');
      const { appCookieOptions } = await import('@/lib/cookies');
      const token = issueCsrfToken(req.session!.id);
      reply.setCookie(CSRF_COOKIE, token, appCookieOptions({ httpOnly: false }));
      return reply.code(400).view('editDrop.ejs', {
        drop,
        viewers,
        csrfToken: token,
        contentUrl: `${dropOriginFor(req.user!.username!, name)}/`,
        viewerError: `"${raw}" is not a valid email address.`,
        formatBytes,
      });
    }

    await addViewer(drop.id, email);
    return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
  });

  app.post('/app/drops/:name/viewers/:email/delete', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name, email } = req.params as { name: string; email: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(req.user!.id, name);
    if (!drop) return reply.code(404).send('not_found');
    await removeViewer(drop.id, decodeURIComponent(email));
    return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
  });
};
