// ABOUTME: Parses drop references written as name (the caller's own drop) or owner/name.
// ABOUTME: Rejects anything that is not one or two valid slugs before any network request.
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
