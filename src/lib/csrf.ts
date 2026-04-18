// ABOUTME: Session- or pending-login-bound CSRF tokens with exact-origin check.
// ABOUTME: Tokens are HMACs of `contextId:nonce`, reissued each time a form is rendered.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@/config';

export const CSRF_COOKIE = 'drops_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function issueCsrfToken(contextId: string): string {
  const nonce = randomBytes(24).toString('base64url');
  const sig = createHmac('sha256', config.SESSION_SECRET)
    .update(contextId + ':' + nonce).digest('base64url');
  return `${nonce}.${sig}`;
}

export function verifyCsrfToken(contextId: string, token: string): boolean {
  const i = token.indexOf('.');
  if (i < 1) return false;
  const nonce = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = createHmac('sha256', config.SESSION_SECRET)
    .update(contextId + ':' + nonce).digest('base64url');
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function originMatches(header: string | undefined): boolean {
  if (!header || header === 'null') return false;
  try {
    const a = new URL(header);
    const b = new URL(config.APP_ORIGIN);
    return a.protocol === b.protocol && a.host === b.host;
  } catch { return false; }
}

export function requestOriginOk(origin: string | undefined, referer: string | undefined): boolean {
  return originMatches(origin) || originMatches(referer);
}
