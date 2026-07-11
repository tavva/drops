// ABOUTME: POST /app/drops/:name/delete — removes a drop and fires off R2 prefix cleanup.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { isValidSlug } from '@/lib/slug';
import { deleteDropWithPrefixes } from '@/services/drops';
import { deletePrefix } from '@/lib/r2';
import { config } from '@/config';

export const deleteDropRoute: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/delete', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const user = req.user!;
    const deleted = await deleteDropWithPrefixes(user.id, name);
    if (!deleted) return reply.code(404).send('not_found');

    for (const prefix of deleted.prefixes) {
      setImmediate(() => {
        deletePrefix(prefix).catch((err) => req.log.warn({ err, prefix }, 'delete prefix failed'));
      });
    }
    return reply.redirect(new URL('/app', config.APP_ORIGIN).toString(), 302);
  });
};
