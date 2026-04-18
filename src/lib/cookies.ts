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
  domain?: undefined;
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
