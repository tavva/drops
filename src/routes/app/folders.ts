// ABOUTME: Folder HTTP routes on the app origin — create, rename, move, delete, plus setDropFolder.
// ABOUTME: All POSTs are CSRF-protected; 303 on success, dashboard re-render with inline banner on validation errors.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import {
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolderReparenting,
  setDropFolder,
  FolderNameTaken,
  FolderNotFound,
  FolderCycle,
  FolderParentNotFound,
  DropNotFound,
  DropNotVisible,
} from '@/services/folders';
import { InvalidFolderName } from '@/lib/folderName';
import { isUuid } from '@/lib/uuid';
import { renderDashboard } from '@/routes/app/dashboardView';

export const folderRoutes: FastifyPluginAsync = async (app) => {
  app.post('/app/folders', { preHandler: requireCompletedMember }, async (req, reply) => {
    const user = req.user!;
    const body = req.body as { name?: string; parentId?: string };
    const rawParent = body.parentId && body.parentId.length > 0 ? body.parentId : null;
    if (rawParent !== null && !isUuid(rawParent)) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'Invalid folder reference.' },
        form: { kind: 'create-folder', values: { name: body.name ?? '', parentId: rawParent } },
      });
    }
    try {
      await createFolder(user.id, body.name ?? '', rawParent);
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof InvalidFolderName) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'Folder name is invalid. Use 1–64 characters, no slashes or control characters.' },
          form: { kind: 'create-folder', values: { name: body.name ?? '', parentId: rawParent ?? '' } },
        });
      }
      if (e instanceof FolderNameTaken) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'A folder with that name already exists here.' },
          form: { kind: 'create-folder', values: { name: body.name ?? '', parentId: rawParent ?? '' } },
        });
      }
      if (e instanceof FolderParentNotFound) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'Parent folder not found.' },
          form: { kind: 'create-folder', values: { name: body.name ?? '' } },
        });
      }
      throw e;
    }
  });

  app.post('/app/folders/:id/rename', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string };
    if (!isUuid(id)) return reply.code(404).send('not_found');
    try {
      await renameFolder(id, body.name ?? '');
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof InvalidFolderName) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'Folder name is invalid. Use 1–64 characters, no slashes or control characters.' },
          form: { kind: 'rename-folder', values: { id, name: body.name ?? '' } },
        });
      }
      if (e instanceof FolderNameTaken) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'A folder with that name already exists here.' },
          form: { kind: 'rename-folder', values: { id, name: body.name ?? '' } },
        });
      }
      if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
      throw e;
    }
  });

  app.post('/app/folders/:id/move', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { parentId?: string };
    if (!isUuid(id)) return reply.code(404).send('not_found');
    const rawParent = body.parentId && body.parentId.length > 0 ? body.parentId : null;
    if (rawParent !== null && !isUuid(rawParent)) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'Invalid folder reference.' },
      });
    }
    try {
      await moveFolder(id, rawParent);
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof FolderCycle) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'A folder can\'t be moved inside itself or one of its subfolders.' },
        });
      }
      if (e instanceof FolderNameTaken) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'The target folder already contains a folder with that name.' },
        });
      }
      if (e instanceof FolderParentNotFound) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'The target folder no longer exists. Pick another destination.' },
        });
      }
      if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
      throw e;
    }
  });

  app.post('/app/folders/:id/delete', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send('not_found');
    try {
      await deleteFolderReparenting(id);
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
      throw e;
    }
  });

  app.post('/app/drops/:id/folder', { preHandler: requireCompletedMember }, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const body = req.body as { folderId?: string };
    if (!isUuid(id)) return reply.code(404).send('not_found');
    const rawFolder = body.folderId && body.folderId.length > 0 ? body.folderId : null;
    const staleFolderBanner = () => renderDashboard(req, reply, {
      statusCode: 400,
      banner: { kind: 'error', message: 'The target folder no longer exists. Pick another destination.' },
    });
    if (rawFolder !== null && !isUuid(rawFolder)) return staleFolderBanner();
    try {
      await setDropFolder({ id: user.id, email: user.email }, id, rawFolder);
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof DropNotFound || e instanceof DropNotVisible) return reply.code(404).send('not_found');
      if (e instanceof FolderNotFound) return staleFolderBanner();
      throw e;
    }
  });
};
