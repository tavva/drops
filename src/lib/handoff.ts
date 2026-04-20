// ABOUTME: Short-lived HMAC tokens used to hand a session from the app origin to a specific drop host.
// ABOUTME: Payload is `sessionId|host|unixExpiry`, base64url encoded, signed with HMAC-SHA256 and verified against the expected host.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type HandoffResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'expired' | 'invalid' };

export function signHandoff(sessionId: string, host: string, key: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${sessionId}|${host}|${exp}`;
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyHandoff(token: string, expectedHost: string, key: string): HandoffResult {
  const i = token.indexOf('.');
  if (i < 1) return { ok: false, reason: 'invalid' };
  let payload: string;
  try { payload = Buffer.from(token.slice(0, i), 'base64url').toString('utf8'); }
  catch { return { ok: false, reason: 'invalid' }; }
  const sig = token.slice(i + 1);
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, reason: 'invalid' };
  const parts = payload.split('|');
  if (parts.length !== 3) return { ok: false, reason: 'invalid' };
  const [sessionId, host, expStr] = parts as [string, string, string];
  if (!sessionId || !host || !expStr) return { ok: false, reason: 'invalid' };
  if (host !== expectedHost) return { ok: false, reason: 'invalid' };
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, sessionId };
}
