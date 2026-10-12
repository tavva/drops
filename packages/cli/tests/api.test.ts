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

  it('accepts the deployment API create response', async () => {
    const result = {
      instance: 'https://drops.example.com',
      name: 'created-site',
      url: 'https://alice--created-site.content.example.com',
      versionId: 'version-created',
      fileCount: 1,
      byteSize: 4,
      entryPath: 'index.html',
    };
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(result, 201));

    await expect(new DropsApiClient(fetch).deployZip({
      origin: 'https://drops.example.com',
      token: 'secret-token',
      name: 'created-site',
      body: Buffer.from('test'),
      contentLength: 4,
    })).resolves.toEqual(result);
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

describe('DropsApiClient listing', () => {
  const listBody = {
    instance: 'https://drops.example.com',
    drops: [{
      name: 'site',
      url: 'https://alice--site.content.example.com',
      updatedAt: '2026-07-16T00:00:00.000Z',
      byteSize: 10,
      fileCount: 1,
      entryPath: null,
      versionId: 'version-1',
      owner: 'alice',
    }],
  };

  it('returns the validated drop list from a bearer request', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(listBody));

    await expect(new DropsApiClient(fetch).listDrops('https://drops.example.com', 'secret-token'))
      .resolves.toEqual(listBody);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://drops.example.com/api/v1/drops');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('requests every viewable drop when asked for all', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(listBody));

    await expect(new DropsApiClient(fetch).listDrops('https://drops.example.com', 'secret-token', { all: true }))
      .resolves.toEqual(listBody);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://drops.example.com/api/v1/drops?scope=all');
  });

  it('rejects drop list entries without an owner as a server error', async () => {
    const withoutOwner: Record<string, unknown> = { ...listBody.drops[0] };
    delete withoutOwner.owner;
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ...listBody, drops: [withoutOwner] }));

    await expect(new DropsApiClient(fetch).listDrops('https://drops.example.com', 'secret-token'))
      .rejects.toMatchObject({ code: 'server_error', exitCode: 6 });
  });

  it('rejects a malformed drop list as a server error', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ drops: [{ name: 42 }] }));

    await expect(new DropsApiClient(fetch).listDrops('https://drops.example.com', 'secret-token'))
      .rejects.toMatchObject({ code: 'server_error', exitCode: 6 });
  });

  it('maps a 401 drop list to not_authenticated', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ error: { code: 'not_authenticated', message: 'Invalid token' } }, 401),
    );

    await expect(new DropsApiClient(fetch).listDrops('https://drops.example.com', 'secret-token'))
      .rejects.toMatchObject({ code: 'not_authenticated', exitCode: 3 });
  });

  it('returns the validated file list for one drop', async () => {
    const body = {
      instance: 'https://drops.example.com',
      name: 'site',
      files: [{ path: 'index.html', size: 14 }, { path: 'assets/app.js', size: 16 }],
    };
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(body));

    await expect(
      new DropsApiClient(fetch).listDropFiles('https://drops.example.com', 'secret-token', 'site'),
    ).resolves.toEqual(body);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://drops.example.com/api/v1/drops/site/files');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('maps a 404 file listing to drop_not_found with exit code 4', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ error: { code: 'drop_not_found', message: 'No drop with that name exists for this user', details: null } }, 404),
    );

    await expect(
      new DropsApiClient(fetch).listDropFiles('https://drops.example.com', 'secret-token', 'missing'),
    ).rejects.toMatchObject({
      code: 'drop_not_found',
      exitCode: 4,
      instance: 'https://drops.example.com',
    });
  });

  it('rejects a malformed file list as a server error', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ name: 'site', files: [{}] }));

    await expect(
      new DropsApiClient(fetch).listDropFiles('https://drops.example.com', 'secret-token', 'site'),
    ).rejects.toMatchObject({ code: 'server_error', exitCode: 6 });
  });
});

describe('DropsApiClient reading', () => {
  const origin = 'https://drops.example.com';
  const filesBody = {
    instance: origin,
    owner: 'bob',
    name: 'site',
    versionId: 'version-1',
    files: [{ path: 'index.html', size: 14 }],
  };

  it('returns the validated file list for any viewable drop', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(filesBody));

    await expect(new DropsApiClient(fetch).readDropFiles(origin, 'secret-token', 'bob', 'site'))
      .resolves.toEqual(filesBody);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://drops.example.com/api/v1/drops/site/files?owner=bob');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('accepts a file list for a drop without a current version', async () => {
    const body = { ...filesBody, versionId: null, files: [] };
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(body));

    await expect(new DropsApiClient(fetch).readDropFiles(origin, 'secret-token', 'bob', 'site')).resolves.toEqual(body);
  });

  it('rejects a file list without owner or version as a server error', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ instance: origin, name: 'site', files: [] }));

    await expect(new DropsApiClient(fetch).readDropFiles(origin, 'secret-token', 'bob', 'site'))
      .rejects.toMatchObject({ code: 'server_error', exitCode: 6 });
  });

  it('maps a 404 file list to drop_not_found with exit code 4', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ error: { code: 'drop_not_found', message: 'No drop', details: null } }, 404),
    );

    await expect(new DropsApiClient(fetch).readDropFiles(origin, 'secret-token', 'bob', 'site')).rejects.toMatchObject({
      code: 'drop_not_found',
      message: 'No drop "bob/site" that you can view on https://drops.example.com',
      instance: origin,
      exitCode: 4,
    });
  });

  it('treats a 404 without drop_not_found from the files route as a server error', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response('Not Found', { status: 404 }));

    await expect(new DropsApiClient(fetch).readDropFiles(origin, 'secret-token', 'bob', 'site'))
      .rejects.toMatchObject({ code: 'server_error', exitCode: 6 });
  });

  it('streams one file through the content route with its owner, path and version', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(bytes, { status: 200 }));

    const body = await new DropsApiClient(fetch).readDropFile(origin, 'secret-token', {
      owner: 'bob',
      name: 'site',
      path: 'assets/a file#1.bin',
      versionId: 'version-1',
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    const [url, init] = fetch.mock.calls[0] ?? [];
    const requested = new URL(String(url));
    expect(requested.origin + requested.pathname).toBe('https://drops.example.com/api/v1/drops/site/content');
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      owner: 'bob', path: 'assets/a file#1.bin', version: 'version-1',
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('omits the version when none is requested', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response('', { status: 200 }));

    await new DropsApiClient(fetch).readDropFile(origin, 'secret-token', { owner: 'bob', name: 'site', path: 'index.html' });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.has('version')).toBe(false);
  });

  it('maps a body that fails mid-stream to network_error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error('socket reset'));
      },
    });
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(stream, { status: 200 }));

    const body = await new DropsApiClient(fetch).readDropFile(origin, 'secret-token', {
      owner: 'bob', name: 'site', path: 'index.html',
    });
    const read = async () => {
      const received: Uint8Array[] = [];
      for await (const chunk of body) received.push(chunk);
      return received;
    };
    await expect(read()).rejects.toMatchObject({ code: 'network_error', instance: origin, exitCode: 5 });
  });

  it.each([
    [404, 'file_not_found', 'No file "missing.html" in bob/site'],
    [404, 'drop_not_found', 'No drop "bob/site" that you can view on https://drops.example.com'],
    [409, 'version_changed', 'bob/site changed while it was being read'],
  ])('maps a %i %s file response to exit code 4', async (status, code, message) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ error: { code, message: 'server message', details: null } }, status),
    );

    await expect(new DropsApiClient(fetch).readDropFile(origin, 'secret-token', {
      owner: 'bob', name: 'site', path: 'missing.html',
    })).rejects.toMatchObject({ code, message, instance: origin, exitCode: 4 });
  });

  it('maps a 401 file response to not_authenticated', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ error: { code: 'not_authenticated', message: 'Invalid token' } }, 401),
    );

    await expect(new DropsApiClient(fetch).readDropFile(origin, 'secret-token', {
      owner: 'bob', name: 'site', path: 'index.html',
    })).rejects.toMatchObject({ code: 'not_authenticated', exitCode: 3 });
  });
});
