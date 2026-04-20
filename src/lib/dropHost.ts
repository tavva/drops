// ABOUTME: Parse and build per-drop subdomain hostnames under the content root domain.
// ABOUTME: Drop host = `<username>--<dropname>.<contentRootDomain>`; parser returns null on mismatch.
import { config } from '@/config';
import { isValidSlug } from '@/lib/slug';

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

export interface DropTarget {
  hostname: string;
  username: string;
  dropname: string;
  origin: string;
  path: string;
}

// Resolve a `next` URL to a drop-host target. Accepts:
//   1) a direct drop-host URL (http/https + configured port + valid <user>--<drop> subdomain);
//   2) an app-host `/auth/drop-bootstrap?host=…&next=…` URL — the pre-auth wrapper used when a
//      logged-out visitor clicks a shared drop link. Unwrapping it here means we can complete the
//      drop-cookie bootstrap directly from the callback, without requiring an app-session cookie
//      (which viewers never receive).
// The returned `origin` is always rebuilt from config.CONTENT_ORIGIN so an attacker cannot smuggle
// in an arbitrary port via the `next` parameter.
export function dropTargetFromNext(nextUrl: string): DropTarget | null {
  let u: URL;
  try { u = new URL(nextUrl); } catch { return null; }

  const direct = parseDropHost(u.hostname);
  if (direct) {
    const content = new URL(config.CONTENT_ORIGIN);
    if (u.protocol !== content.protocol || u.port !== content.port) return null;
    return {
      hostname: u.hostname.toLowerCase(),
      username: direct.username,
      dropname: direct.dropname,
      origin: dropOriginFor(direct.username, direct.dropname),
      path: (u.pathname + u.search) || '/',
    };
  }

  const app = new URL(config.APP_ORIGIN);
  if (u.protocol === app.protocol && u.host === app.host && u.pathname === '/auth/drop-bootstrap') {
    const hostParam = (u.searchParams.get('host') ?? '').toLowerCase();
    const parsed = parseDropHost(hostParam);
    if (!parsed) return null;
    const rawNext = u.searchParams.get('next') ?? '/';
    const path = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
    return {
      hostname: hostParam,
      username: parsed.username,
      dropname: parsed.dropname,
      origin: dropOriginFor(parsed.username, parsed.dropname),
      path,
    };
  }

  return null;
}

export function parseDropHost(hostHeader: string | undefined): ParsedDropHost | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0]!.toLowerCase();
  if (!host) return null;
  const root = contentRootDomain();
  if (host === root) return null;
  if (!host.endsWith('.' + root)) return null;
  const sub = host.slice(0, host.length - root.length - 1);
  // Split on `--`. Ambiguous splits (e.g. `a--b--c`) produce an invalid username or dropname
  // once isValidSlug rejects consecutive hyphens, so the validation below also catches them.
  const idx = sub.indexOf('--');
  if (idx < 0) return null;
  if (sub.indexOf('--', idx + 2) >= 0) return null;  // more than one `--` — ambiguous
  const username = sub.slice(0, idx);
  const dropname = sub.slice(idx + 2);
  if (!isValidSlug(username) || !isValidSlug(dropname)) return null;
  return { username, dropname };
}
