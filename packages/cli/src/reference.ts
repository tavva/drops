// ABOUTME: Parses drop references written as name (the caller's own drop) or owner/name,
// ABOUTME: and checks relative drop file paths, before any network request.
import { DROP_SLUG } from './deploy.js';
import { invalidDropNameError, invalidReferenceError } from './errors.js';

export interface DropReference {
  owner?: string;
  name: string;
}

export function parseDropReference(value: string, example: string): DropReference {
  const parts = value.split('/');
  if (parts.length === 1) {
    if (!DROP_SLUG.test(value)) throw invalidDropNameError(value, example);
    return { name: value };
  }
  const [owner, name] = parts;
  if (parts.length !== 2 || !DROP_SLUG.test(owner!) || !DROP_SLUG.test(name!)) {
    throw invalidReferenceError(value, example);
  }
  return { owner: owner!, name: name! };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// A relative path whose every segment can name a drop entry, so it cannot escape a
// destination directory on disk.
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || CONTROL_CHARACTERS.test(path)) {
    return false;
  }
  // Drops never contain dot-prefixed entries, which also rules out `.` and `..`.
  return path.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));
}
