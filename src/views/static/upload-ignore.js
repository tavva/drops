// ABOUTME: Client-side filter for OS metadata that should never reach the server.
// ABOUTME: The server is strict about dotfiles; we silently drop known-benign junk first.
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IGNORED_SEGMENTS = new Set(['__MACOSX', '.AppleDouble']);

export function shouldIgnore(path) {
  const segs = path.split('/');
  const basename = segs[segs.length - 1];
  if (IGNORED_BASENAMES.has(basename)) return true;
  for (const seg of segs) if (IGNORED_SEGMENTS.has(seg)) return true;
  return false;
}
