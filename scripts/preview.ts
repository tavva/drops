// ABOUTME: Local design-review server — renders every EJS view with canned fake locals.
// ABOUTME: No DB, no R2, no auth. Run with `pnpm dev:preview`, open http://localhost:4000.
import Fastify from 'fastify';
import view from '@fastify/view';
import fastifyStatic from '@fastify/static';
import ejs from 'ejs';
import { resolve } from 'node:path';

const APP_ORIGIN = 'http://drops.localtest.me:4000';
const CONTENT_ORIGIN = 'http://content.localtest.me:4000';

const app = Fastify({ logger: false });

await app.register(view, { engine: { ejs }, root: 'src/views' });
await app.register(fastifyStatic, {
  root: resolve('src/views/static'),
  prefix: '/app/static/',
});

const fakeUser = { id: 'u_1', username: 'ben', email: 'ben@example.com' };
const sampleDrops = [
  { name: 'launch-notes', version: { id: '0198f3c2-2a7b-72d0-9d4f-1fc01b2e', fileCount: 47, byteSize: 18_400_000 } },
  { name: 'tidepools', version: { id: '0198f3c2-2a7b-72d0-9d4f-1fc01b2f', fileCount: 12, byteSize: 2_100_000 } },
  { name: 'site', version: { id: '0198f3c2-2a7b-72d0-9d4f-1fc01b30', fileCount: 3, byteSize: 80_400 } },
  { name: 'draft', version: null },
];
const sampleAll = [
  { name: 'launch-notes', ownerUsername: 'ben' },
  { name: 'retro-2026-q1', ownerUsername: 'alice' },
  { name: 'sprint-brief', ownerUsername: 'noah' },
  { name: 'docs', ownerUsername: 'alice' },
];

const pages: Array<{ path: string; title: string; description: string }> = [
  { path: '/choose-username', title: 'Choose username', description: 'First-time signup, username preview.' },
  { path: '/choose-username/error', title: 'Choose username — error', description: 'Shows a validation error.' },
  { path: '/dashboard', title: 'Dashboard', description: 'Drops list + Everyone\u2019s drops.' },
  { path: '/dashboard/empty', title: 'Dashboard — empty', description: 'No drops yet — empty state.' },
  { path: '/new-drop', title: 'New drop', description: 'Name field + dropzone.' },
  { path: '/edit-drop', title: 'Edit drop', description: 'Version card + replace + delete modal.' },
  { path: '/edit-drop/empty', title: 'Edit drop — no version', description: 'Drop exists but nothing uploaded.' },
];

app.get('/', async (_req, reply) => {
  reply.type('text/html; charset=utf-8');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>drops — preview</title>
<link rel="stylesheet" href="/app/static/style.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
</head><body class="app-viewport">
<div class="app-main" style="max-width: 720px;">
  <div class="page-head"><h1>Preview</h1></div>
  <div class="card">
    <div class="section-head"><h2>Screens</h2><span class="count">${pages.length}</span></div>
    <ul style="list-style:none;padding:0;margin:0;">
      ${pages.map((p) => `<li style="padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:baseline;">
        <a href="${p.path}" style="font-family:var(--font-display);color:var(--ink-1);font-weight:500;min-width:220px;">${p.title}</a>
        <span style="color:var(--ink-3);font-size:13px;">${p.description}</span>
        <span style="margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--ink-4);">${p.path}</span>
      </li>`).join('')}
    </ul>
  </div>
  <p class="hint" style="margin-top:16px;">No DB, no R2, no auth. Forms submit to dead routes — styling only.</p>
</div>
</body></html>`;
});

app.get('/choose-username', (_req, reply) =>
  reply.view('chooseUsername.ejs', {
    email: 'ben@example.com', suggested: 'ben', next: '/app',
    csrfToken: 'preview', error: null, contentOrigin: CONTENT_ORIGIN,
  }));

app.get('/choose-username/error', (_req, reply) =>
  reply.view('chooseUsername.ejs', {
    email: 'ben@example.com', suggested: 'admin', next: '/app',
    csrfToken: 'preview', error: 'That username is reserved.', contentOrigin: CONTENT_ORIGIN,
  }));

app.get('/dashboard', (_req, reply) =>
  reply.view('dashboard.ejs', {
    user: fakeUser,
    yourDrops: sampleDrops,
    allDrops: sampleAll,
    contentOrigin: CONTENT_ORIGIN,
    csrfToken: 'preview',
  }));

app.get('/dashboard/empty', (_req, reply) =>
  reply.view('dashboard.ejs', {
    user: fakeUser,
    yourDrops: [],
    allDrops: [],
    contentOrigin: CONTENT_ORIGIN,
    csrfToken: 'preview',
  }));

app.get('/new-drop', (_req, reply) =>
  reply.view('newDrop.ejs', { csrfToken: 'preview' }));

app.get('/edit-drop', (_req, reply) =>
  reply.view('editDrop.ejs', {
    drop: { name: 'tidepools', version: { id: '0198f3c2-2a7b-72d0-9d4f-1fc01b2e', fileCount: 47, byteSize: 18_400_000 } },
    csrfToken: 'preview',
    contentUrl: `${CONTENT_ORIGIN}/ben/tidepools/`,
  }));

app.get('/edit-drop/empty', (_req, reply) =>
  reply.view('editDrop.ejs', {
    drop: { name: 'draft', version: null },
    csrfToken: 'preview',
    contentUrl: `${CONTENT_ORIGIN}/ben/draft/`,
  }));

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`\n  drops preview  →  http://localhost:${port}\n`);
console.log(`  App origin     ${APP_ORIGIN}`);
console.log(`  Content origin ${CONTENT_ORIGIN}\n`);
for (const p of pages) console.log(`  ${p.path.padEnd(30)} ${p.title}`);
console.log('');
