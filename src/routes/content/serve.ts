// ABOUTME: Content-apex legacy redirect: /:username/:dropname[/*] → https://<user>--<drop>.<root>/<*>.
// ABOUTME: Exists so pre-cutover URLs keep working after drops move to per-drop subdomains.
import type { FastifyPluginAsync } from 'fastify';
import { isValidSlug } from '@/lib/slug';
import { dropOriginFor } from '@/lib/dropHost';

export const contentServeRoute: FastifyPluginAsync = async (app) => {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/:username/:dropname',
    config: { skipCsrf: true },
    handler: async (req, reply) => {
      const { username, dropname } = req.params as { username: string; dropname: string };
      if (!isValidSlug(username) || !isValidSlug(dropname)) return reply.code(404).send('not_found');
      return reply.redirect(`${dropOriginFor(username, dropname)}/`, 301);
    },
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/:username/:dropname/*',
    config: { skipCsrf: true },
    handler: async (req, reply) => {
      const { username, dropname } = req.params as { username: string; dropname: string };
      if (!isValidSlug(username) || !isValidSlug(dropname)) return reply.code(404).send('not_found');
      const splat = (req.params as Record<string, string>)['*'] ?? '';
      const qi = (req.raw.url ?? '').indexOf('?');
      const query = qi >= 0 ? (req.raw.url as string).slice(qi) : '';
      return reply.redirect(`${dropOriginFor(username, dropname)}/${splat}${query}`, 301);
    },
  });
};
