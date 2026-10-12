// ABOUTME: Bearer-authenticated read APIs listing drops and one drop's files with sizes.
// ABOUTME: Reads of another owner's drop apply canView and give every refusal the same 404 as a missing drop.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { listPrefixObjects } from '@/lib/r2';
import { isValidSlug } from '@/lib/slug';
import { requireCliToken } from '@/middleware/cliAuth';
import { findByOwnerAndName, listAllVisibleUnpaged, listByOwner, type DropSummary } from '@/services/drops';
import { canView } from '@/services/permissions';
import { findByUsername } from '@/services/users';

type ApiErrorCode = 'invalid_name' | 'invalid_scope' | 'drop_not_found' | 'rate_limited' | 'internal_error';

const messages: Record<ApiErrorCode, string> = {
  invalid_name: 'The drop name must be a valid slug',
  invalid_scope: 'The scope must be mine or all',
  drop_not_found: 'No drop with that name exists for this user',
  rate_limited: 'Too many list requests',
  internal_error: 'An unexpected error occurred',
};

function apiError(reply: FastifyReply, statusCode: number, code: ApiErrorCode) {
  return reply.code(statusCode).send({ error: { code, message: messages[code], details: null } });
}

async function findViewableDrop(
  user: { id: string; email: string },
  ownerName: string,
  name: string,
): Promise<DropSummary | null> {
  const owner = await findByUsername(ownerName);
  if (owner === null) return null;
  const drop = await findByOwnerAndName(owner.id, name);
  if (drop === null) return null;
  return await canView(user, drop) ? drop : null;
}

async function fileEntries(drop: DropSummary) {
  if (drop.version === null) return [];
  const prefix = drop.version.r2Prefix;
  const objects = await listPrefixObjects(prefix);
  return objects.map((object) => ({ path: object.key.slice(prefix.length), size: object.size }));
}

function toListEntry(drop: DropSummary, owner: string) {
  return {
    name: drop.name,
    owner,
    url: dropOriginFor(owner, drop.name),
    updatedAt: drop.updatedAt.toISOString(),
    byteSize: drop.version?.byteSize ?? 0,
    fileCount: drop.version?.fileCount ?? 0,
    entryPath: drop.version?.entryPath ?? null,
    versionId: drop.version?.id ?? null,
  };
}

export const cliReadRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? error.statusCode
      : undefined;
    if (statusCode === 429) return apiError(reply, 429, 'rate_limited');
    request.log.error({ err: error, request_id: request.id }, 'CLI list request failed');
    return apiError(reply, 500, 'internal_error');
  });

  app.get('/api/v1/drops', { preHandler: requireCliToken }, async (request, reply) => {
    const { scope = 'mine' } = request.query as { scope?: unknown };
    const user = request.user!;
    if (scope === 'all') {
      const candidates = await listAllVisibleUnpaged({ id: user.id, email: user.email });
      // The listing query assumes the caller is an allowlisted member; canView stays the authority.
      const allowed = await Promise.all(candidates.map((drop) => canView(user, drop)));
      const visible = candidates.filter((drop, index) => allowed[index] && drop.ownerUsername !== null);
      return {
        instance: config.APP_ORIGIN,
        drops: visible.map((drop) => toListEntry(drop, drop.ownerUsername!)),
      };
    }
    if (scope !== 'mine') return apiError(reply, 400, 'invalid_scope');
    const summaries = await listByOwner(user.id);
    return {
      instance: config.APP_ORIGIN,
      drops: summaries.map((drop) => toListEntry(drop, user.username!)),
    };
  });

  app.get('/api/v1/drops/:name/files', { preHandler: requireCliToken }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { owner } = request.query as { owner?: unknown };
    if (owner === undefined) {
      if (!isValidSlug(name)) return apiError(reply, 400, 'invalid_name');
      const drop = await findByOwnerAndName(request.user!.id, name);
      if (drop === null) return apiError(reply, 404, 'drop_not_found');
      return { instance: config.APP_ORIGIN, name, files: await fileEntries(drop) };
    }
    if (typeof owner !== 'string' || !isValidSlug(owner) || !isValidSlug(name)) {
      return apiError(reply, 400, 'invalid_name');
    }
    const drop = await findViewableDrop(request.user!, owner, name);
    if (drop === null) return apiError(reply, 404, 'drop_not_found');
    return {
      instance: config.APP_ORIGIN,
      owner,
      name,
      versionId: drop.version?.id ?? null,
      files: await fileEntries(drop),
    };
  });
};
