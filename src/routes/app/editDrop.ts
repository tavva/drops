// ABOUTME: GET /app/drops/:name — renders the edit page for a drop the caller owns.
import type { FastifyPluginAsync } from 'fastify';
import { requireAppSession } from '@/middleware/auth';
import { findByOwnerAndName } from '@/services/drops';
import { isValidSlug } from '@/lib/slug';
import { config } from '@/config';

export const editDropRoute: FastifyPluginAsync = async (app) => {
  app.get('/app/drops/:name', { preHandler: requireAppSession }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const user = req.user!;
    const drop = await findByOwnerAndName(user.id, name);
    if (!drop) return reply.code(404).send('not_found');
    return reply.view('editDrop.ejs', {
      drop,
      csrfToken: req.csrfToken ?? '',
      contentUrl: new URL(`/${user.username}/${name}/`, config.CONTENT_ORIGIN).toString(),
    });
  });
};
