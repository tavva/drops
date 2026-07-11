// ABOUTME: Dashboard route for revoking the signed-in member's CLI authorisations.
// ABOUTME: Owner, missing, invalid, and already-revoked token ids all share a safe 404 response.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { revokeCliTokenByOwner } from '@/services/cliAuth';
import { isUuid } from '@/lib/uuid';

export const cliTokenRoutes: FastifyPluginAsync = async (app) => {
  app.post('/app/cli/tokens/:id/revoke', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send('not_found');

    const revoked = await revokeCliTokenByOwner(id, req.user!.id);
    if (!revoked) return reply.code(404).send('not_found');
    return reply.code(303).header('location', '/app?cli_revoked=1').send();
  });
};
