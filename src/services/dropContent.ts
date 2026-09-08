// ABOUTME: Resolves drop paths against one published version and retrieves its R2 content.
// ABOUTME: Shares entry-point, directory-index, single-file, and path-hardening behaviour across clients.
import { getObject, listPrefix } from '@/lib/r2';
import { sanitisePath } from '@/lib/path';

export async function getDropContent(
  version: { r2Prefix: string; entryPath: string | null; fileCount: number },
  path: string,
) {
  const isRoot = path === '';
  let rest = isRoot && version.entryPath ? version.entryPath : path;
  if (rest === '' || rest.endsWith('/')) rest += 'index.html';
  const result = sanitisePath(rest);
  if (!result.ok) return null;
  let resolvedPath = result.path;
  let found = await getObject(version.r2Prefix + resolvedPath);
  if (!found && !resolvedPath.endsWith('.html')) {
    resolvedPath = result.path + '/index.html';
    found = await getObject(version.r2Prefix + resolvedPath);
  }
  if (!found && isRoot && version.fileCount === 1) {
    const keys = await listPrefix(version.r2Prefix);
    if (keys.length === 1 && keys[0]) {
      resolvedPath = keys[0].slice(version.r2Prefix.length);
      found = await getObject(keys[0]);
    }
  }
  return found ? { ...found, path: resolvedPath } : null;
}
