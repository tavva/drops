// ABOUTME: Sanitises relative upload/request paths to reject traversal, dotfiles, and control chars.
// ABOUTME: Applies NFC normalisation and rejects any `.` or empty segment that is not a leading prefix.
export enum PathRejection {
  Empty = 'empty',
  AbsolutePath = 'absolute_path',
  ParentSegment = 'parent_segment',
  DotSegment = 'dot_segment',
  ControlChar = 'control_char',
  Dotfile = 'dotfile',
  TrailingSlash = 'trailing_slash',
}

export type PathResult =
  | { ok: true; path: string }
  | { ok: false; reason: PathRejection };

const CONTROL = /[\x00-\x1f\x7f]/;

export function sanitisePath(input: string): PathResult {
  if (!input) return { ok: false, reason: PathRejection.Empty };
  const nfc = input.normalize('NFC');
  if (CONTROL.test(nfc)) return { ok: false, reason: PathRejection.ControlChar };
  if (nfc.startsWith('/') || nfc.startsWith('\\') || /^[A-Za-z]:[/\\]/.test(nfc)) {
    return { ok: false, reason: PathRejection.AbsolutePath };
  }
  if (nfc.endsWith('/')) return { ok: false, reason: PathRejection.TrailingSlash };

  const raw = nfc.split('/');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]!;
    if (seg === '') {
      if (i === 0) continue;
      return { ok: false, reason: PathRejection.DotSegment };
    }
    if (seg === '.') {
      if (i === 0) continue;
      return { ok: false, reason: PathRejection.DotSegment };
    }
    if (seg === '..') return { ok: false, reason: PathRejection.ParentSegment };
    if (seg.startsWith('.')) return { ok: false, reason: PathRejection.Dotfile };
    out.push(seg);
  }
  if (out.length === 0) return { ok: false, reason: PathRejection.Empty };
  return { ok: true, path: out.join('/') };
}
