// ABOUTME: Verifies the typed Drops v1 API client request and response contract.
// ABOUTME: Covers redirect isolation, error mapping, bearer redaction, and streamed upload progress.
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { DropsApiClient, type FetchLike } from '../src/api.js';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('DropsApiClient discovery', () => {
  it('discovers a compatible instance without following redirects', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ service: 'drops', apiVersion: 1, appOrigin: 'https://drops.example.com' }),
    );

    await expect(new DropsApiClient(fetch).discover('https://drops.example.com')).resolves.toEqual({
      service: 'drops',
      apiVersion: 1,
      appOrigin: 'https://drops.example.com',
    });
    expect(fetch).toHaveBeenCalledWith('https://drops.example.com/.well-known/drops', {
      method: 'GET',
      redirect: 'manual',
    });
  });

  it.each([
    { service: 'other', apiVersion: 1, appOrigin: 'https://drops.example.com' },
    { service: 'drops', apiVersion: 2, appOrigin: 'https://drops.example.com' },
    { service: 'drops', apiVersion: 1, appOrigin: 'https://other.example.com' },
    { service: 'drops', apiVersion: 1 },
    null,
  ])('rejects incompatible discovery JSON %#', async (document) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(document));

    await expect(new DropsApiClient(fetch).discover('https://drops.example.com')).rejects.toMatchObject({
      code: 'instance_incompatible',
      exitCode: 5,
    });
  });

  it('rejects an origin-changing discovery redirect without following it', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/discovery' } }));

    await expect(new DropsApiClient(fetch).discover('https://drops.example.com')).rejects.toMatchObject({
      code: 'instance_incompatible',
      exitCode: 5,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('follows a bounded same-origin discovery redirect with manual redirect handling', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/v1/discovery' } }))
      .mockResolvedValueOnce(
        jsonResponse({ service: 'drops', apiVersion: 1, appOrigin: 'https://drops.example.com' }),
      );

    await expect(new DropsApiClient(fetch).discover('https://drops.example.com')).resolves.toEqual({
      service: 'drops',
      apiVersion: 1,
      appOrigin: 'https://drops.example.com',
    });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual([
      ['https://drops.example.com/.well-known/drops', 'manual'],
      ['https://drops.example.com/v1/discovery', 'manual'],
    ]);
  });

  it('rejects missing, invalid, looping, and over-limit discovery redirects', async () => {
    const missing = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 302 }));
    const invalid = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://[' } }));
    const looping = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: '/.well-known/drops' } }));
    const overLimit = vi.fn<FetchLike>().mockImplementation(async (url) => {
      const current = new URL(String(url));
      const count = Number(current.searchParams.get('hop') ?? '0');
      return new Response(null, { status: 302, headers: { location: `?hop=${count + 1}` } });
    });

    for (const fetch of [missing, invalid, looping, overLimit]) {
      await expect(new DropsApiClient(fetch).discover('https://drops.example.com')).rejects.toMatchObject({
        code: 'instance_incompatible',
        exitCode: 5,
      });
    }
    expect(looping).toHaveBeenCalledTimes(1);
    expect(overLimit).toHaveBeenCalledTimes(4);
  });
});

describe('DropsApiClient authentication', () => {
  it('transports the exact exchange values and already-sanitised label', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        token: 'drops_cli_returned',
        user: { id: 'user-1', email: 'user@example.com', username: 'alice' },
      }),
    );
    const client = new DropsApiClient(fetch);

    await expect(
      client.exchangeCode({
        origin: 'https://drops.example.com',
        code: 'one-time-code',
        verifier: 'pkce-verifier',
        redirectUri: 'http://127.0.0.1:43123/callback?fixed=yes',
        label: 'Drops CLI on Bens-Mac',
      }),
    ).resolves.toEqual({
      token: 'drops_cli_returned',
      user: { id: 'user-1', email: 'user@example.com', username: 'alice' },
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://drops.example.com/api/v1/auth/token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      code: 'one-time-code',
      verifier: 'pkce-verifier',
      redirectUri: 'http://127.0.0.1:43123/callback?fixed=yes',
      label: 'Drops CLI on Bens-Mac',
    });
  });

  it('gets the current user with a bearer request that cannot follow redirects', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ id: 'user-1', email: 'user@example.com', username: 'alice' }));

    await expect(new DropsApiClient(fetch).whoami('https://drops.example.com', 'secret-token')).resolves.toEqual({
      id: 'user-1',
      email: 'user@example.com',
      username: 'alice',
    });
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('distinguishes successful revocation from an already-invalid token', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'not_authenticated', message: 'Invalid token' } }, 401));
    const client = new DropsApiClient(fetch);

    await expect(client.revokeCurrentToken('https://drops.example.com', 'token-one')).resolves.toEqual({
      status: 'revoked',
    });
    await expect(client.revokeCurrentToken('https://drops.example.com', 'token-two')).resolves.toEqual({
      status: 'already_invalid',
    });
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ method: 'DELETE', redirect: 'manual' });
    }
  });
});

describe('DropsApiClient deployment', () => {
  it('sends a zip with exact headers and returns the typed deployment result', async () => {
    const result = {
      instance: 'https://drops.example.com',
      name: 'sample-site',
      url: 'https://alice--sample-site.content.example.com',
      versionId: 'version-1',
      fileCount: 2,
      byteSize: 8,
      entryPath: 'index.html',
    };
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(result));
    const body = Buffer.from('zip-body');

    await expect(
      new DropsApiClient(fetch).deployZip({
        origin: 'https://drops.example.com',
        token: 'secret-token',
        name: 'sample site',
        body,
        contentLength: body.length,
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://drops.example.com/api/v1/drops/sample%20site/deployments');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-token');
    expect(headers.get('content-type')).toBe('application/zip');
    expect(headers.get('content-length')).toBe('8');
  });

  it('supports a stream body with an upload progress seam', async () => {
    const observedChunks: Buffer[] = [];
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      for await (const chunk of init?.body as unknown as AsyncIterable<Buffer>) {
        observedChunks.push(Buffer.from(chunk));
      }
      return jsonResponse({
        instance: 'https://drops.example.com',
        name: 'sample',
        url: 'https://sample.example.com',
        versionId: 'version-1',
        fileCount: 1,
        byteSize: 6,
        entryPath: null,
      });
    });
    const onProgress = vi.fn();

    await new DropsApiClient(fetch).deployZip({
      origin: 'https://drops.example.com',
      token: 'token',
      name: 'sample',
      body: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      contentLength: 6,
      onProgress,
    });

    expect(Buffer.concat(observedChunks).toString()).toBe('abcdef');
    expect(onProgress.mock.calls).toEqual([
      [3, 6],
      [6, 6],
    ]);
  });
});

describe('DropsApiClient errors', () => {
  it('maps 401 to not_authenticated without exposing the bearer token', async () => {
    const token = 'drops_cli_secret';
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: { code: token, message: `Bearer ${token} rejected` } }, 401));

    let thrown: unknown;
    try {
      await new DropsApiClient(fetch).whoami('https://drops.example.com', token);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'not_authenticated', exitCode: 3 });
    expect(String(thrown)).not.toContain(token);
    expect(JSON.stringify(thrown)).not.toContain(token);
  });

  it.each([400, 413])('maps upload status %i to the structured upload code and exit 4', async (status) => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: { code: 'invalid_zip', message: 'The zip is invalid', details: null } }, status));

    await expect(
      new DropsApiClient(fetch).deployZip({
        origin: 'https://drops.example.com',
        token: 'token',
        name: 'sample',
        body: Buffer.alloc(0),
        contentLength: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_zip', exitCode: 4 });
  });

  it('preserves safe structured error details while redacting nested secrets', async () => {
    const token = 'drops_cli_nested_secret';
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'total_size',
            message: 'The upload is too large',
            details: {
              maximumBytes: 100,
              receivedBytes: 120,
              diagnostics: [`Bearer ${token}`, { credential: token }],
            },
          },
        },
        413,
      ),
    );

    let thrown: unknown;
    try {
      await new DropsApiClient(fetch).deployZip({
        origin: 'https://drops.example.com',
        token,
        name: 'sample',
        body: Buffer.alloc(0),
        contentLength: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'total_size',
      exitCode: 4,
      details: {
        maximumBytes: 100,
        receivedBytes: 120,
        diagnostics: ['Bearer [redacted]', { credential: '[redacted]' }],
      },
    });
    expect(JSON.stringify(thrown)).not.toContain(token);
  });

  it.each(['drops_cli_server_leak', 'INVALID-CODE', 'a'.repeat(65)])(
    'reclassifies unsafe structured error code %s without exposing it',
    async (unsafeCode) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(
        jsonResponse({ error: { code: unsafeCode, message: 'Rejected', details: null } }, 400),
      );

      let thrown: unknown;
      try {
        await new DropsApiClient(fetch).deployZip({
          origin: 'https://drops.example.com',
          token: unsafeCode,
          name: 'sample',
          body: Buffer.alloc(0),
          contentLength: 0,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: 'server_error', details: null, exitCode: 6 });
      expect(JSON.stringify(thrown)).not.toContain(unsafeCode);
    },
  );

  it.each(['unsafe', ['not', 'an', 'object'], 42])(
    'drops non-object structured error details %j',
    async (details) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(
        jsonResponse({ error: { code: 'invalid_zip', message: 'The zip is invalid', details } }, 400),
      );

      await expect(
        new DropsApiClient(fetch).deployZip({
          origin: 'https://drops.example.com',
          token: 'token',
          name: 'sample',
          body: Buffer.alloc(0),
          contentLength: 0,
        }),
      ).rejects.toMatchObject({ code: 'invalid_zip', details: null, exitCode: 4 });
    },
  );

  it('maps fetch failures to network_error without reusing their message', async () => {
    const token = 'drops_cli_secret';
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error(`socket failed with ${token}`));

    let thrown: unknown;
    try {
      await new DropsApiClient(fetch).whoami('https://drops.example.com', token);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'network_error', exitCode: 5 });
    expect(String(thrown)).not.toContain(token);
  });

  it('maps redirects and malformed successful API responses to server_error', async () => {
    const redirectingFetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'https://evil.example.com/api/v1/whoami' } }),
    );
    const malformedFetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ email: 'missing fields' }));

    await expect(
      new DropsApiClient(redirectingFetch).whoami('https://drops.example.com', 'token'),
    ).rejects.toMatchObject({ code: 'server_error', exitCode: 6 });
    await expect(new DropsApiClient(malformedFetch).whoami('https://drops.example.com', 'token')).rejects.toMatchObject(
      { code: 'server_error', exitCode: 6 },
    );
    expect(redirectingFetch).toHaveBeenCalledTimes(1);
  });
});
