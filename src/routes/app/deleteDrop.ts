// ABOUTME: POST /app/drops/:name/delete — removes a drop and fires off R2 prefix cleanup.
import { FastifyPluginAsync } from 'fastify';
import { requireAppSession } from '@/middleware/auth';
import { isValidSlug } from '@/lib/slug';
import { findByOwnerAndName, listVersionsForDrop, deleteDrop } from '@/services/drops';
import { deletePrefix } from '@/lib/r2';
import { config } from '@/config';

export const deleteDropRoute: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/delete', { preHandler: requireAppSession }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const user = req.user!;
    const drop = await findByOwnerAndName(user.id, name);
    if (!drop) return reply.code(404).send('not_found');

    const versions = await listVersionsForDrop(drop.id);
    const ok = await deleteDrop(drop.id, user.id);
    if (!ok) return reply.code(404).send('not_found');

    for (const v of versions) {
      setImmediate(() => {
        deletePrefix(v.r2Prefix).catch((err) => req.log.warn({ err, prefix: v.r2Prefix }, 'delete prefix failed'));
      });
    }
    return reply.redirect(new URL('/app', config.APP_ORIGIN).toString(), 302);
  });
};
