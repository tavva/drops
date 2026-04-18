// ABOUTME: OpenID Connect client for Google. Discovery is cached for the life of the process.
// ABOUTME: `exchangeCode` verifies the id_token (including nonce) and returns a normalised identity.
import * as client from 'openid-client';
import { config } from '@/config';

const GOOGLE_ISSUER = 'https://accounts.google.com';

let configured: client.Configuration | undefined;

async function getConfig(): Promise<client.Configuration> {
  if (configured) return configured;
  const cfg = await client.discovery(
    new URL(GOOGLE_ISSUER),
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
  );
  configured = cfg;
  return cfg;
}

export interface AuthUrlInput {
  state: string;
  nonce: string;
  redirectUri: string;
}

export async function buildAuthUrl(input: AuthUrlInput): Promise<string> {
  const cfg = await getConfig();
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: input.redirectUri,
    scope: 'openid email profile',
    state: input.state,
    nonce: input.nonce,
    response_type: 'code',
    access_type: 'online',
    prompt: 'select_account',
  });
  return url.href;
}

export interface OAuthIdentity {
  email: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export interface ExchangeInput {
  currentUrl: string;
  expectedNonce: string;
  expectedState: string;
}

export async function exchangeCode(input: ExchangeInput): Promise<OAuthIdentity> {
  const cfg = await getConfig();
  const tokens = await client.authorizationCodeGrant(
    cfg,
    new URL(input.currentUrl),
    {
      expectedNonce: input.expectedNonce,
      expectedState: input.expectedState,
      idTokenExpected: true,
    },
  );
  const claims = tokens.claims();
  if (!claims) throw new Error('id_token missing claims');
  const email = typeof claims.email === 'string' ? claims.email : null;
  if (!email) throw new Error('id_token missing email');
  const emailVerified = claims.email_verified === true;
  const name = typeof claims.name === 'string' ? claims.name : null;
  const avatarUrl = typeof claims.picture === 'string' ? claims.picture : null;
  return { email, emailVerified, name, avatarUrl };
}

export function __resetForTests() { configured = undefined; }
