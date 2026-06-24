// ABOUTME: POST /app/drops/:name/entry — owner sets the version's homepage (entry_path).
// ABOUTME: Validates the chosen path is an .html/.htm file in the current version; non-owner returns 404.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { findByOwnerAndName, setEntryPath } from '@/services/drops';
import { listPrefix } from '@/lib/r2';
import { isValidSlug } from '@/lib/slug';
import { config } from '@/config';

export const setEntryRoute: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/entry', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(req.user!.id, name);
    if (!drop || !drop.version) return reply.code(404).send('not_found');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const entry = body.entry ?? ''; // exact stored path — do NOT trim (filenames may have edge whitespace)

    if (entry === '') {
      await setEntryPath(drop.version.id, null);
      return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
    }

    const prefix = drop.version.r2Prefix;
    const rels = (await listPrefix(prefix)).map((k) => k.slice(prefix.length));
    if (!rels.includes(entry) || !/\.html?$/i.test(entry)) return reply.code(400).send('bad_entry');

    await setEntryPath(drop.version.id, entry);
    return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
  });
};
