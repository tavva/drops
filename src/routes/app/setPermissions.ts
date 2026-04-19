// ABOUTME: POST /app/drops/:name/permissions — owner sets the drop's view mode.
// ABOUTME: Validates against ('authed' | 'public' | 'emails'); non-owner returns 404 (no enumeration).
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { findByOwnerAndName } from '@/services/drops';
import { setViewMode } from '@/services/permissions';
import { isValidSlug } from '@/lib/slug';
import { config } from '@/config';

const VALID = new Set(['authed', 'public', 'emails']);

export const setPermissionsRoute: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/permissions', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(req.user!.id, name);
    if (!drop) return reply.code(404).send('not_found');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const mode = body.mode ?? '';
    if (!VALID.has(mode)) return reply.code(400).send('bad_mode');

    await setViewMode(drop.id, mode as 'authed' | 'public' | 'emails');
    return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
  });
};
