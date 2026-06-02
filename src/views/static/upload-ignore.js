// ABOUTME: Filters OS and tool metadata junk (e.g. .DS_Store, .thumbnail) out of uploads.
// ABOUTME: Shared by the browser folder picker and the server folder/zip upload paths.
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.thumbnail']);
const IGNORED_SEGMENTS = new Set(['__MACOSX', '.AppleDouble']);

export function shouldIgnore(path) {
  const segs = path.split('/');
  const basename = segs[segs.length - 1];
  if (IGNORED_BASENAMES.has(basename)) return true;
  for (const seg of segs) if (IGNORED_SEGMENTS.has(seg)) return true;
  return false;
}
