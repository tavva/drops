// ABOUTME: Shared dashboard render path used by the dashboard route and the folder routes on error.
// ABOUTME: Takes an optional inline error banner and echoes the submitted form values back to the user.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { listFolderTree, type FolderTree } from '@/services/folders';
import { formatBytes } from '@/lib/format';
import { dropOriginFor } from '@/lib/dropHost';

export interface DashboardRenderOptions {
  banner?: { kind: 'error' | 'info'; message: string } | null;
  form?: { kind: 'create-folder' | 'rename-folder' | 'move-folder'; values: Record<string, string> } | null;
  statusCode?: number;
}

export interface FolderPathEntry { id: string; path: string }

export function buildFolderPathList(tree: FolderTree): FolderPathEntry[] {
  const out: FolderPathEntry[] = [];
  function walk(id: string, prefix: string) {
    const node = tree.byId.get(id);
    if (!node) return;
    const path = prefix ? `${prefix} / ${node.name}` : node.name;
    out.push({ id, path });
    for (const childId of node.childFolderIds) walk(childId, path);
  }
  for (const rootId of tree.rootFolderIds) walk(rootId, '');
  return out;
}

export async function renderDashboard(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: DashboardRenderOptions = {},
) {
  const user = req.user!;
  const mineOnly = (req.query as { mine?: string }).mine === '1';
  const tree = await listFolderTree({ id: user.id, email: user.email }, { mineOnly });
  const folderPathList = buildFolderPathList(tree);
  if (opts.statusCode) reply.code(opts.statusCode);
  return reply.view('dashboard.ejs', {
    user,
    tree,
    mineOnly,
    folderPathList,
    banner: opts.banner ?? null,
    form: opts.form ?? null,
    csrfToken: req.csrfToken ?? '',
    formatBytes,
    dropOriginFor,
  });
}
