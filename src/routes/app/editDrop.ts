// ABOUTME: GET /app/drops/:name — renders the edit page for a drop the caller owns.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { findByOwnerAndName } from '@/services/drops';
import { listViewers } from '@/services/dropViewers';
import { isValidSlug } from '@/lib/slug';
import { formatBytes } from '@/lib/format';
import { dropOriginFor } from '@/lib/dropHost';

export const editDropRoute: FastifyPluginAsync = async (app) => {
  app.get('/app/drops/:name', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const user = req.user!;
    const drop = await findByOwnerAndName(user.id, name);
    if (!drop) return reply.code(404).send('not_found');
    const viewers = drop.viewMode === 'emails' ? await listViewers(drop.id) : [];
    return reply.view('editDrop.ejs', {
      drop,
      viewers,
      csrfToken: req.csrfToken ?? '',
      contentUrl: `${dropOriginFor(user.username!, name)}/`,
      viewerError: null,
      formatBytes,
    });
  });
};
