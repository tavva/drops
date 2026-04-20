// ABOUTME: HMAC-signed cookie helpers plus origin-aware cookie option factories.
// ABOUTME: `secure` flag follows APP_ORIGIN/CONTENT_ORIGIN scheme so dev (http) and prod (https) share code.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@/config';

function mac(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

export function signCookie(value: string, key: string): string {
  return `${value}.${mac(value, key)}`;
}

export function verifyCookie(signed: string, key: string): string | null {
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const sig = signed.slice(i + 1);
  const expected = mac(value, key);
  if (sig.length !== expected.length) return null;
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return timingSafeEqual(a, b) ? value : null;
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge?: number;
  domain?: string;
}

function isSecureOrigin(origin: string): boolean {
  return new URL(origin).protocol === 'https:';
}

export function appCookieOptions(overrides: Partial<CookieOptions> = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureOrigin(config.APP_ORIGIN),
    sameSite: 'lax',
    path: '/',
    ...overrides,
  };
}

export function contentCookieOptions(overrides: Partial<CookieOptions> = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureOrigin(config.CONTENT_ORIGIN),
    sameSite: 'lax',
    path: '/',
    ...overrides,
  };
}

export function signDropCookie(sessionId: string, host: string, key: string): string {
  const payload = `${sessionId}|${host}`;
  return `${payload}.${mac(payload, key)}`;
}

export function verifyDropCookie(raw: string, expectedHost: string, key: string): string | null {
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = mac(payload, key);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parts = payload.split('|');
  if (parts.length !== 2) return null;
  const [sessionId, host] = parts as [string, string];
  if (!sessionId || !host) return null;
  if (host !== expectedHost) return null;
  return sessionId;
}

export function dropCookieOptions(host: string, overrides: Partial<CookieOptions> = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureOrigin(config.CONTENT_ORIGIN),
    sameSite: 'lax',
    path: '/',
    domain: host,
    ...overrides,
  };
}
