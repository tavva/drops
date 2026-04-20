// ABOUTME: Drop-host GET|HEAD / and /* — streams R2 content for the drop identified by the request host.
// ABOUTME: Applies path sanitisation, directory→index.html fallback, and ETag-based 304 handling.
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { requireDropSession } from '@/middleware/auth';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canView } from '@/services/permissions';
import { getObject } from '@/lib/r2';
import { sanitisePath } from '@/lib/path';

function isHeadOrGet(method: string): method is 'GET' | 'HEAD' {
  return method === 'GET' || method === 'HEAD';
}

async function serve(req: FastifyRequest, reply: FastifyReply) {
  if (!isHeadOrGet(req.method)) return reply.code(405).send('method_not_allowed');
  const parsed = req.dropHost;
  if (!parsed) return reply.code(404).send('not_found');
  const splat = (req.params as Record<string, string>)['*'] ?? '';

  const owner = await findByUsername(parsed.username);
  if (!owner) return reply.code(404).send('not_found');
  const drop = await findByOwnerAndName(owner.id, parsed.dropname);
  if (!drop || !drop.version) return reply.code(404).send('not_found');
  const allowed = await canView(
    { id: req.user!.id, email: req.user!.email },
    { id: drop.id, ownerId: drop.ownerId, viewMode: drop.viewMode },
  );
  if (!allowed) return reply.code(404).send('not_found');
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
}

const DROP_HOST_REGEX = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]--[a-z0-9][a-z0-9-]{0,30}[a-z0-9]\.[^/]+$/;

export const dropServeRoute: FastifyPluginAsync = async (app) => {
  const method: ('GET' | 'HEAD')[] = ['GET', 'HEAD'];
  const common = {
    method,
    preHandler: requireDropSession,
    constraints: { host: DROP_HOST_REGEX },
    config: { skipCsrf: true },
    handler: serve,
  };
  app.route({ ...common, url: '/' });
  app.route({ ...common, url: '/*' });
};
