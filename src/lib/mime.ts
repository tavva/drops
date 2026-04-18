// ABOUTME: Extension-based MIME lookup for static drop files.
// ABOUTME: Unknown extensions, leading-dot names, and trailing-dot names fall back to octet-stream.
const MAP: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
};

export function mimeFor(path: string): string {
  const i = path.lastIndexOf('.');
  if (i <= 0 || i === path.length - 1) return 'application/octet-stream';
  const ext = path.slice(i + 1).toLowerCase();
  return MAP[ext] ?? 'application/octet-stream';
}
