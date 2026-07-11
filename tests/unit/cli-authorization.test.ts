// ABOUTME: Unit coverage for strict CLI browser-authorisation request validation.
// ABOUTME: Exercises loopback callback, PKCE, state, and callback construction without database access.
import { describe, expect, it } from 'vitest';
import {
  CliAuthorizationRequestError,
  approvalCallback,
  denialCallback,
  validateCliAuthorizationRequest,
} from '@/routes/cli/authorize';

const valid = {
  redirect_uri: 'http://127.0.0.1:49152/callback',
  state: 'state_0123456789abcdef',
  code_challenge: 'A'.repeat(43),
  code_challenge_method: 'S256',
};

describe('CLI authorisation request validation', () => {
  it('accepts an exact IPv4 loopback callback on an ephemeral port', () => {
    expect(validateCliAuthorizationRequest(valid)).toEqual({
      redirectUri: valid.redirect_uri,
      state: valid.state,
      codeChallenge: valid.code_challenge,
    });
  });

  it.each([
    undefined,
    '',
    'http://localhost:49152/callback',
    'http://[::1]:49152/callback',
    'http://user@127.0.0.1:49152/callback',
    'http://127.0.0.1:49152/callback#fragment',
    'https://127.0.0.1:49152/callback',
    'http://127.0.0.2:49152/callback',
    'http://2130706433:49152/callback',
    'http://0x7f000001:49152/callback',
    'http://0177.0.0.1:49152/callback',
    'http://127.0.0.1:049152/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:49151/callback',
    'http://127.0.0.1:65536/callback',
    'http://127.0.0.1:49152/',
    'http://127.0.0.1:49152/callback/',
    'http://127.0.0.1:49152/callback?existing=1',
  ])('rejects unsafe redirect URI %j', (redirectUri) => {
    expect(() => validateCliAuthorizationRequest({ ...valid, redirect_uri: redirectUri }))
      .toThrowError(CliAuthorizationRequestError);
  });

  it.each([undefined, '', 'plain', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`])(
    'rejects malformed S256 challenge %j',
    (challenge) => {
      expect(() => validateCliAuthorizationRequest({ ...valid, code_challenge: challenge }))
        .toThrowError(CliAuthorizationRequestError);
    },
  );

  it.each([undefined, '', 's256', 'plain'])('requires method exactly S256 (%j)', (method) => {
    expect(() => validateCliAuthorizationRequest({ ...valid, code_challenge_method: method }))
      .toThrowError(CliAuthorizationRequestError);
  });

  it.each([undefined, '', 'short', 'bad state with spaces', 'bad\nstate', 'x'.repeat(257)])(
    'rejects missing or unsafe state %j',
    (state) => {
      expect(() => validateCliAuthorizationRequest({ ...valid, state }))
        .toThrowError(CliAuthorizationRequestError);
    },
  );

  it('returns a typed, stable, non-secret error', () => {
    try {
      validateCliAuthorizationRequest({ ...valid, redirect_uri: 'https://evil.example/steal?secret=yes' });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CliAuthorizationRequestError);
      expect(error).toMatchObject({ code: 'invalid_request', message: 'Invalid CLI authorisation request' });
      expect(JSON.stringify(error)).not.toContain('evil.example');
      expect(JSON.stringify(error)).not.toContain('secret');
    }
  });
});

describe('CLI loopback callback construction', () => {
  it('constructs approval with only code and original state', () => {
    expect(approvalCallback(valid.redirect_uri, 'one-time-code', valid.state).toString())
      .toBe(`${valid.redirect_uri}?code=one-time-code&state=${valid.state}`);
  });

  it('constructs denial with access_denied and original state', () => {
    expect(denialCallback(valid.redirect_uri, valid.state).toString())
      .toBe(`${valid.redirect_uri}?error=access_denied&state=${valid.state}`);
  });
});
