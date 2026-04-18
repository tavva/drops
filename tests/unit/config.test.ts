import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '@/config';

const BASE = {
  DATABASE_URL: 'postgres://u:p@h/db',
  R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd',
  GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs',
  SESSION_SECRET: 'x'.repeat(64),
  ALLOWED_DOMAIN: 'drops.global',
  APP_ORIGIN: 'https://drops.example',
  CONTENT_ORIGIN: 'https://content.example',
};

describe('loadConfig', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  it('parses a valid environment', () => {
    process.env = { ...BASE };
    expect(loadConfig().APP_ORIGIN).toBe('https://drops.example');
  });

  it('throws when SESSION_SECRET is too short', () => {
    process.env = { ...BASE, SESSION_SECRET: 'short' };
    expect(() => loadConfig()).toThrow(/SESSION_SECRET/);
  });

  it('throws when APP_ORIGIN equals CONTENT_ORIGIN', () => {
    process.env = { ...BASE, CONTENT_ORIGIN: BASE.APP_ORIGIN };
    expect(() => loadConfig()).toThrow(/must differ/);
  });

  it('accepts optional R2_ENDPOINT for local MinIO', () => {
    process.env = { ...BASE, R2_ENDPOINT: 'http://localhost:9000' };
    expect(loadConfig().R2_ENDPOINT).toBe('http://localhost:9000');
  });
});
