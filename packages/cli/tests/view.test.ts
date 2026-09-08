// ABOUTME: Covers terminal reads and authenticated browser opening without live credentials or browsers.
// ABOUTME: Pins target validation, redirect safety, binary handling, and headless output.
import { describe, expect, it, vi } from 'vitest';
import { DropsApiClient } from '../src/api.js';
import { parseViewArguments } from '../src/commands/view.js';
import { runCli } from '../src/index.js';
import { open, view, type ViewDependencies } from '../src/view.js';

const origin = 'https://drops.example.com';
const url = 'https://alice--site.content.example.com/';
const openResult = { instance: origin, name: 'site', url,
  openUrl: `${url}auth/bootstrap?token=handoff&next=%2F`, expiresIn: 60 };
const viewResult = { instance: origin, name: 'site', path: 'index.html',
  contentType: 'text/html', encoding: 'utf8' as const, content: '<h1>Hello</h1>' };
const options = { cwd: '/repo', target: 'site', json: false };
function deps(): ViewDependencies {
  return { api: { viewDrop: vi.fn().mockResolvedValue(viewResult), openDrop: vi.fn().mockResolvedValue(openResult) },
    store: { get: vi.fn().mockResolvedValue('secret') }, resolveInstance: vi.fn().mockResolvedValue(origin),
    openBrowser: vi.fn().mockResolvedValue(undefined) };
}

describe('view and open commands', () => {
  it.each(['view', 'open'] as const)('parses %s targets and flags', (command) => {
    expect(parseViewArguments(command, ['alice/site', 'assets/app.js', '--instance', origin, '--json']))
      .toMatchObject({ target: 'alice/site', path: 'assets/app.js', instance: origin, json: true });
    for (const args of [[], ['site', 'a', 'b'], ['site', '--unknown'], ['site', '--instance', origin, '--instance', origin]]) {
      expect(() => parseViewArguments(command, args)).toThrow(expect.objectContaining({ code: 'usage_error' }));
    }
  });
  it('keeps browser flags out of terminal viewing', () => {
    expect(() => parseViewArguments('view', ['site', '--no-browser'])).toThrow();
  });
  it.each(['../site', 'alice/site/extra', 'INVALID', 'https://evil.example'])('rejects target %s before credentials or discovery', async (target) => {
    const d = deps();
    await expect(view({ ...options, target }, d)).rejects.toMatchObject({ code: 'usage_error' });
    expect(d.resolveInstance).not.toHaveBeenCalled();
    expect(d.store.get).not.toHaveBeenCalled();
  });
  it.each(['../secret', '/etc/passwd', '//evil.example', 'a/../b', '.env', 'a//b', 'a\\b', 'a\x1bb'])('rejects unsafe path %s', async (path) => {
    const d = deps();
    await expect(open({ ...options, path }, vi.fn(), d)).rejects.toMatchObject({ code: 'usage_error' });
    expect(d.api.openDrop).not.toHaveBeenCalled();
  });
  it('reads shared drops with the exact instance credential', async () => {
    const d = deps();
    await view({ ...options, target: 'alice/site', instance: origin, path: 'docs/' }, d);
    expect(d.resolveInstance).toHaveBeenCalledWith({ cwd: '/repo', explicit: origin });
    expect(d.store.get).toHaveBeenCalledWith(origin);
    expect(d.api.viewDrop).toHaveBeenCalledWith(origin, 'secret', { owner: 'alice', name: 'site', path: 'docs/' });
  });
  it('requires login for reading and opening', async () => {
    const d = deps();
    vi.mocked(d.store.get).mockResolvedValue(null);
    await expect(view(options, d)).rejects.toMatchObject({ code: 'not_authenticated', exitCode: 3 });
    await expect(open(options, vi.fn(), d)).rejects.toMatchObject({ code: 'not_authenticated', exitCode: 3 });
    expect(d.api.openDrop).not.toHaveBeenCalled();
    expect(d.api.viewDrop).not.toHaveBeenCalled();
  });
  it('prints a handoff before opening the browser and supports no-browser', async () => {
    const d = deps();
    const diagnostic = vi.fn();
    await open(options, diagnostic, d);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(openResult.openUrl));
    expect(d.openBrowser).toHaveBeenCalledWith(openResult.openUrl);
    vi.mocked(d.openBrowser).mockClear();
    await open({ ...options, noBrowser: true }, diagnostic, d);
    expect(d.openBrowser).not.toHaveBeenCalled();
  });
  it('keeps the copyable URL available if browser launch fails', async () => {
    const d = deps();
    vi.mocked(d.openBrowser).mockRejectedValue(new Error('failed'));
    const diagnostic = vi.fn();
    await expect(open(options, diagnostic, d)).resolves.toEqual(openResult);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('manually'));
  });
  it('rejects binary terminal output while allowing base64 JSON', async () => {
    const d = deps();
    vi.mocked(d.api.viewDrop).mockResolvedValue({ ...viewResult, encoding: 'base64', content: 'AA==' });
    await expect(view(options, d)).rejects.toMatchObject({ code: 'binary_file' });
    await expect(view({ ...options, json: true }, d)).resolves.toMatchObject({ encoding: 'base64' });
  });
  it('prints source content for terminal viewing', async () => {
    let stdout = '';
    const result = await runCli(['view', 'site'], { cwd: '/repo',
      stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: vi.fn() },
    }, undefined, { view: deps() });
    expect(result).toBe(0);
    expect(stdout).toBe('<h1>Hello</h1>\n');
  });
  it.each(['view', 'open'])('dispatches %s with one JSON result', async (command) => {
    let stdout = ''; let stderr = '';
    const d = deps();
    const result = await runCli([command, 'site', '--json'], { cwd: '/repo',
      stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } },
    }, undefined, { view: d });
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual(command === 'view' ? viewResult : openResult);
    expect(stderr).toBe('');
  });
});

describe('viewing API client', () => {
  it('sends bearer credentials only to the selected app API with encoded query paths', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<h1>Hello</h1>', { headers: {
      'x-drops-path': 'docs/a%20b.html', 'x-drops-content-type': 'text/html',
    } }));
    const api = new DropsApiClient(fetch);
    const result = await api.viewDrop(origin, 'secret', { name: 'site', owner: 'alice', path: 'docs/a b.html' });
    const [requested, init] = fetch.mock.calls[0]!;
    expect(new URL(requested).origin).toBe(origin);
    expect(new URL(requested).searchParams.get('path')).toBe('docs/a b.html');
    expect(new URL(requested).searchParams.get('owner')).toBe('alice');
    expect(init.redirect).toBe('manual');
    expect(init.headers.get('authorization')).toBe('Bearer secret');
    expect(result).toMatchObject({ path: 'docs/a b.html', content: '<h1>Hello</h1>', encoding: 'utf8' });
  });
  it.each([new Uint8Array([0xff, 0x00]), new TextEncoder().encode('\x1b[2J')])('encodes binary or terminal controls as base64', async (bytes) => {
    const api = new DropsApiClient(vi.fn().mockResolvedValue(new Response(bytes)));
    expect(await api.viewDrop(origin, 'secret', { name: 'site' })).toMatchObject({
      encoding: 'base64', content: Buffer.from(bytes).toString('base64'),
    });
  });
  it('bounds chunked content reads', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(6 * 1024 * 1024)); },
      cancel() { cancelled = true; } });
    const api = new DropsApiClient(vi.fn().mockResolvedValue(new Response(body)));
    await expect(api.viewDrop(origin, 'secret', { name: 'site' })).rejects.toMatchObject({ code: 'file_too_large' });
    expect(cancelled).toBe(true);
  });
  it.each(['viewDrop', 'openDrop'] as const)('never follows %s redirects', async (method) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
    await expect(new DropsApiClient(fetch)[method](origin, 'secret', { name: 'site' })).rejects.toMatchObject({ code: 'server_error' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['viewDrop', 'openDrop'] as const)('maps %s authentication and permission errors', async (method) => {
    for (const status of [401, 404]) {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'drop_not_found', message: 'Missing' } }), { status }));
      await expect(new DropsApiClient(fetch)[method](origin, 'secret', { name: 'site' })).rejects.toMatchObject({ exitCode: status === 401 ? 3 : 4 });
    }
  });
  it('validates browser URLs before returning them', async () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://evil.example/auth/bootstrap?token=t&next=%2F']) {
      const api = new DropsApiClient(vi.fn().mockResolvedValue(Response.json({ ...openResult, openUrl: bad })));
      await expect(api.openDrop(origin, 'secret', { name: 'site' })).rejects.toMatchObject({ code: 'server_error' });
    }
    const api = new DropsApiClient(vi.fn().mockResolvedValue(Response.json(openResult)));
    await expect(api.openDrop(origin, 'secret', { name: 'site' })).resolves.toEqual(openResult);
  });
});
