// ABOUTME: GET /app/drops/:name — renders the edit page for a drop the caller owns.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { findByOwnerAndName } from '@/services/drops';
import { listViewers } from '@/services/dropViewers';
import { listAllowedEmails } from '@/services/allowlist';
import { isValidSlug } from '@/lib/slug';
import { formatBytes } from '@/lib/format';
import { dropOriginFor } from '@/lib/dropHost';
import { listPrefix } from '@/lib/r2';
import { encodePath } from '@/lib/path';
import { config } from '@/config';

export const editDropRoute: FastifyPluginAsync = async (app) => {
  app.get('/app/drops/:name', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const user = req.user!;
    const drop = await findByOwnerAndName(user.id, name);
    if (!drop) return reply.code(404).send('not_found');
    const viewers = drop.viewMode === 'emails' ? await listViewers(drop.id) : [];
    const collaborators = drop.viewMode === 'emails' ? await listAllowedEmails() : [];

    let entryCandidates: { path: string; preview: string }[] = [];
    let showEntryPicker = false;
    let homepageResolves = true;
    let currentEntry = '';
    if (drop.version) {
      const prefix = drop.version.r2Prefix;
      const rels = (await listPrefix(prefix)).map((k) => k.slice(prefix.length));
      const base = dropOriginFor(user.username!, name);
      entryCandidates = rels
        .filter((p) => /\.html?$/i.test(p))
        .map((p) => ({ path: p, preview: `${base}/${encodePath(p)}` }));
      currentEntry = drop.version.entryPath ?? '';
      homepageResolves = rels.includes('index.html') || drop.version.entryPath != null || drop.version.fileCount === 1;
      showEntryPicker = !homepageResolves && entryCandidates.length > 0;
    }

    return reply.view('editDrop.ejs', {
      drop,
      viewers,
      collaborators,
      allowedDomain: config.ALLOWED_DOMAIN,
      csrfToken: req.csrfToken ?? '',
      contentUrl: `${dropOriginFor(user.username!, name)}/`,
      viewerError: null,
      formatBytes,
      entryCandidates,
      showEntryPicker,
      homepageResolves,
      currentEntry,
    });
  });
};
