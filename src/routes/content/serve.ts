// ABOUTME: GET /:username/:dropname/* — streams R2 content after authenticating the content session.
// ABOUTME: Applies path sanitisation, directory→index.html fallback, and ETag-based 304 handling.
import type { FastifyPluginAsync } from 'fastify';
import { requireContentSession } from '@/middleware/auth';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { getObject } from '@/lib/r2';
import { sanitisePath } from '@/lib/path';
import { config } from '@/config';

function isHeadOrGet(method: string): method is 'GET' | 'HEAD' {
  return method === 'GET' || method === 'HEAD';
}

export const contentServeRoute: FastifyPluginAsync = async (app) => {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/:username/:dropname',
    preHandler: requireContentSession,
    config: { skipCsrf: true },
    handler: async (req, reply) => {
      const { username, dropname } = req.params as { username: string; dropname: string };
      const target = new URL(`/${username}/${dropname}/`, config.CONTENT_ORIGIN);
      return reply.redirect(target.toString(), 301);
    },
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/:username/:dropname/*',
    preHandler: requireContentSession,
    config: { skipCsrf: true },
    handler: async (req, reply) => {
      if (!isHeadOrGet(req.method)) return reply.code(405).send('method_not_allowed');
      const { username, dropname } = req.params as { username: string; dropname: string };
      const splat = (req.params as Record<string, string>)['*'] ?? '';

      const user = await findByUsername(username);
      if (!user) return reply.code(404).send('not_found');
      const drop = await findByOwnerAndName(user.id, dropname);
      if (!drop || !drop.version) return reply.code(404).send('not_found');
      const prefix = drop.version.r2Prefix;

      let rest = splat;
      const bareRoot = rest === '' || rest.endsWith('/');
      if (bareRoot) rest += 'index.html';
      const result = sanitisePath(rest);
      if (!result.ok) return reply.code(404).send('not_found');
      const sanitised = result.path;

      let found = await getObject(prefix + sanitised);
      if (!found && !sanitised.endsWith('.html') && !sanitised.endsWith('/')) {
        found = await getObject(prefix + sanitised + '/index.html');
      }
      if (!found && bareRoot && drop.version.fileCount === 1) {
        const { listPrefix } = await import('@/lib/r2');
        const keys = await listPrefix(prefix);
        if (keys.length === 1 && keys[0]) {
          found = await getObject(keys[0]);
        }
      }
      if (!found) return reply.code(404).send('not_found');

      const inm = req.headers['if-none-match'];
      if (inm && found.etag && inm === found.etag) {
        return reply.code(304).send();
      }

      reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
      reply.type(found.contentType);
      if (found.etag) reply.header('ETag', found.etag);
      if (found.contentLength !== undefined) reply.header('Content-Length', String(found.contentLength));

      if (req.method === 'HEAD') {
        found.body.destroy();
        return reply.send();
      }
      return reply.send(found.body);
    },
  });
};
