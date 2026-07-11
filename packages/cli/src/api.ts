// ABOUTME: Provides a typed, redirect-safe client for the Drops v1 CLI API.
// ABOUTME: Maps transport and server failures to stable secret-safe CLI errors.
import type { Readable } from 'node:stream';

import { DropsCliError, type DropsCliErrorDetails } from './errors.js';

export interface DropsDiscovery {
  service: 'drops';
  apiVersion: 1;
  appOrigin: string;
}

export interface DropsUser {
  id: string;
  email: string;
  username: string;
}

export interface DropsTokenExchange {
  token: string;
  user: DropsUser;
}

export interface DropsDeploymentResult {
  instance: string;
  name: string;
  url: string;
  versionId: string;
  fileCount: number;
  byteSize: number;
  entryPath: string | null;
}

export interface DropsApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: DropsCliErrorDetails;
  };
}

export type RevokeCurrentTokenResult = { status: 'revoked' } | { status: 'already_invalid' };

export interface FetchRequestInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit | AsyncIterable<Uint8Array>;
  duplex?: 'half';
}

export type FetchLike = (input: string | URL | Request, init?: FetchRequestInit) => Promise<Response>;

export interface ExchangeCodeOptions {
  origin: string;
  code: string;
  verifier: string;
  redirectUri: string;
  label: string;
}

export type ZipBody = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export interface DeployZipOptions {
  origin: string;
  token: string;
  name: string;
  body: ZipBody;
  contentLength: number;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

interface StructuredError {
  code: string;
  message: string;
  details: DropsCliErrorDetails;
}

const MAX_DISCOVERY_REDIRECTS = 3;

const defaultFetch: FetchLike = (input, init) => fetch(input, init as RequestInit);

function incompatible(origin: string): DropsCliError {
  return new DropsCliError({
    code: 'instance_incompatible',
    message: `The instance at ${origin} is not compatible with Drops CLI API v1`,
    instance: origin,
    exitCode: 5,
  });
}

function networkError(origin: string): DropsCliError {
  return new DropsCliError({
    code: 'network_error',
    message: `Could not connect to ${origin}`,
    instance: origin,
    exitCode: 5,
  });
}

function serverError(origin: string): DropsCliError {
  return new DropsCliError({
    code: 'server_error',
    message: `The instance at ${origin} returned an unexpected response`,
    instance: origin,
    exitCode: 6,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUser(value: unknown): value is DropsUser {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.email === 'string' &&
    typeof value.username === 'string'
  );
}

function isDeployment(value: unknown): value is DropsDeploymentResult {
  return (
    isRecord(value) &&
    typeof value.instance === 'string' &&
    typeof value.name === 'string' &&
    typeof value.url === 'string' &&
    typeof value.versionId === 'string' &&
    typeof value.fileCount === 'number' &&
    typeof value.byteSize === 'number' &&
    (typeof value.entryPath === 'string' || value.entryPath === null)
  );
}

function redactString(value: string, secrets: string[]): string {
  let redacted = value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function sanitizeJsonValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 10) return '[redacted]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, secrets, depth + 1));
  if (!isRecord(value)) return null;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[redactString(key, secrets)] = sanitizeJsonValue(item, secrets, depth + 1);
  }
  return result;
}

function safeDetails(value: unknown, secrets: string[]): DropsCliErrorDetails {
  if (value === null || !isRecord(value)) return null;
  return sanitizeJsonValue(value, secrets) as Record<string, unknown>;
}

function isSafeErrorCode(value: unknown, secrets: string[]): value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) return false;
  if (value.startsWith('drops_cli_')) return false;
  return !secrets.some((secret) => secret.length > 0 && value.includes(secret));
}

function parseStructuredError(value: unknown, secrets: string[]): StructuredError | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  if (!isSafeErrorCode(value.error.code, secrets)) return null;
  if (typeof value.error.message !== 'string') return null;

  const message = redactString(value.error.message.slice(0, 1_000), secrets);
  return { code: value.error.code, message, details: safeDetails(value.error.details ?? null, secrets) };
}

async function jsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

async function* withProgress(
  body: ZipBody,
  totalBytes: number,
  onProgress: (uploadedBytes: number, totalBytes: number) => void,
): AsyncIterable<Uint8Array> {
  let uploadedBytes = 0;
  if (body instanceof Uint8Array) {
    uploadedBytes = body.byteLength;
    yield body;
    onProgress(uploadedBytes, totalBytes);
    return;
  }

  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    uploadedBytes += bytes.byteLength;
    yield bytes;
    onProgress(uploadedBytes, totalBytes);
  }
}

export class DropsApiClient {
  constructor(private readonly fetchImpl: FetchLike = defaultFetch) {}

  async discover(origin: string): Promise<DropsDiscovery> {
    let url = `${origin}/.well-known/drops`;
    const visited = new Set([url]);
    let redirectCount = 0;
    let response: Response;

    while (true) {
      response = await this.request(origin, url, { method: 'GET', redirect: 'manual' });
      if (!isRedirect(response)) break;
      if (redirectCount >= MAX_DISCOVERY_REDIRECTS) throw incompatible(origin);

      const location = response.headers.get('location');
      if (location === null) throw incompatible(origin);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw incompatible(origin);
      }
      if (next.origin !== origin || visited.has(next.href)) throw incompatible(origin);
      url = next.href;
      visited.add(url);
      redirectCount += 1;
    }
    if (response.status !== 200) throw incompatible(origin);

    const document = await jsonOrNull(response);
    if (
      !isRecord(document) ||
      document.service !== 'drops' ||
      document.apiVersion !== 1 ||
      document.appOrigin !== origin
    ) {
      throw incompatible(origin);
    }
    return { service: 'drops', apiVersion: 1, appOrigin: origin };
  }

  async exchangeCode(options: ExchangeCodeOptions): Promise<DropsTokenExchange> {
    const response = await this.request(options.origin, `${options.origin}/api/v1/auth/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: options.code,
        verifier: options.verifier,
        redirectUri: options.redirectUri,
        label: options.label,
      }),
    });
    if (response.status !== 200) {
      await this.throwForResponse(response, options.origin, [options.code, options.verifier]);
    }
    const result = await jsonOrNull(response);
    if (!isRecord(result) || typeof result.token !== 'string' || !isUser(result.user)) {
      throw serverError(options.origin);
    }
    return { token: result.token, user: result.user };
  }

  async whoami(origin: string, token: string): Promise<DropsUser> {
    const response = await this.bearerRequest(origin, token, `${origin}/api/v1/whoami`, { method: 'GET' });
    if (response.status !== 200) await this.throwForResponse(response, origin, [token]);
    const user = await jsonOrNull(response);
    if (!isUser(user)) throw serverError(origin);
    return user;
  }

  async revokeCurrentToken(origin: string, token: string): Promise<RevokeCurrentTokenResult> {
    const response = await this.bearerRequest(origin, token, `${origin}/api/v1/auth/token`, { method: 'DELETE' });
    if (response.status === 204) return { status: 'revoked' };
    if (response.status === 401) return { status: 'already_invalid' };
    return await this.throwForResponse(response, origin, [token]);
  }

  async deployZip(options: DeployZipOptions): Promise<DropsDeploymentResult> {
    const body = options.onProgress
      ? withProgress(options.body, options.contentLength, options.onProgress)
      : options.body;
    const response = await this.bearerRequest(
      options.origin,
      options.token,
      `${options.origin}/api/v1/drops/${encodeURIComponent(options.name)}/deployments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/zip',
          'content-length': String(options.contentLength),
        },
        body: body as BodyInit | AsyncIterable<Uint8Array>,
        ...(options.onProgress || !(body instanceof Uint8Array) ? { duplex: 'half' as const } : {}),
      },
    );
    if (response.status !== 200 && response.status !== 201) {
      await this.throwForResponse(response, options.origin, [options.token], true);
    }
    const result = await jsonOrNull(response);
    if (!isDeployment(result)) throw serverError(options.origin);
    return result;
  }

  private async bearerRequest(
    origin: string,
    token: string,
    url: string,
    init: FetchRequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await this.request(origin, url, { ...init, headers, redirect: 'manual' });
    if (isRedirect(response)) throw serverError(origin);
    return response;
  }

  private async request(origin: string, url: string, init: FetchRequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual' });
    } catch {
      throw networkError(origin);
    }
  }

  private async throwForResponse(
    response: Response,
    origin: string,
    secrets: string[],
    upload = false,
  ): Promise<never> {
    if (response.status === 401) {
      throw new DropsCliError({
        code: 'not_authenticated',
        message: `Run: drops login ${origin}`,
        instance: origin,
        exitCode: 3,
      });
    }
    const body = await jsonOrNull(response);
    if (isRecord(body) && isRecord(body.error) && !isSafeErrorCode(body.error.code, secrets)) {
      throw serverError(origin);
    }
    const structured = parseStructuredError(body, secrets);
    if (structured?.code === 'authorisation_denied') {
      throw new DropsCliError({ ...structured, instance: origin, exitCode: 3 });
    }
    if (upload && (response.status === 400 || response.status === 413)) {
      throw new DropsCliError({
        code: structured?.code ?? 'upload_rejected',
        message: structured?.message ?? 'The instance rejected the upload',
        details: structured?.details ?? null,
        instance: origin,
        exitCode: 4,
      });
    }
    throw serverError(origin);
  }
}
