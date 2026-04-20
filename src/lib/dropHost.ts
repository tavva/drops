// ABOUTME: Parse and build per-drop subdomain hostnames under the content root domain.
// ABOUTME: Drop host = `<username>--<dropname>.<contentRootDomain>`; parser returns null on mismatch.
import { config } from '@/config';

export function contentRootDomain(): string {
  return new URL(config.CONTENT_ORIGIN).hostname.toLowerCase();
}

export function dropHostFor(username: string, dropname: string, root: string = contentRootDomain()): string {
  return `${username}--${dropname}.${root}`;
}

export function dropOriginFor(username: string, dropname: string): string {
  const u = new URL(config.CONTENT_ORIGIN);
  u.hostname = dropHostFor(username, dropname, u.hostname.toLowerCase());
  return u.origin;
}

export interface ParsedDropHost {
  username: string;
  dropname: string;
}

const SEG = '[a-z0-9][a-z0-9-]{0,30}[a-z0-9]';
const PARSE_RE = new RegExp(`^(${SEG})--(${SEG})$`);

export function parseDropHost(hostHeader: string | undefined): ParsedDropHost | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0]!.toLowerCase();
  if (!host) return null;
  const root = contentRootDomain();
  if (host === root) return null;
  if (!host.endsWith('.' + root)) return null;
  const sub = host.slice(0, host.length - root.length - 1);
  const m = PARSE_RE.exec(sub);
  if (!m) return null;
  return { username: m[1]!, dropname: m[2]! };
}
