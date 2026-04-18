# drops Drops Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a private static-site host at `drops.drops.global` (app) and `content.drops.drops.global` (served drops) per the design at `docs/plans/2026-04-18-drops-drops-design.md`.

**Architecture:** One Fastify+TypeScript service on Railway. Postgres (metadata) + Cloudflare R2 (files). App and content live on separate origins with separate session cookies. Atomic-replace uploads: each upload writes to a fresh R2 prefix and a single `UPDATE` flips `drops.current_version`; the old prefix is garbage-collected after commit.

**Tech Stack:**
- Runtime: Node 22, TypeScript, ESM
- Package manager: pnpm
- HTTP: Fastify 5 with `@fastify/cookie`, `@fastify/formbody`, `@fastify/multipart`, `@fastify/view` (EJS), `@fastify/rate-limit`
- DB: Postgres via Drizzle ORM (`drizzle-orm` + `postgres` driver) + `drizzle-kit` for migrations
- Object store: Cloudflare R2 via `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`
- OAuth: `openid-client` (OIDC with Google)
- Zip: `yauzl`
- Logging: Pino (built into Fastify)
- Testing: Vitest (unit + integration), Playwright (E2E)
- Local dev: Docker Compose (Postgres + MinIO)

**Directory layout** (created incrementally by the tasks below):

```
src/
  config.ts
  db/{index.ts,schema.ts,migrations/}
  lib/{slug.ts,mime.ts,path.ts,cookies.ts,oauth.ts,r2.ts,handoff.ts,csrf.ts}
  services/{allowlist.ts,sessions.ts,pendingLogins.ts,users.ts,drops.ts,gc.ts,upload.ts}
  middleware/{host.ts,auth.ts}
  routes/
    health.ts
    auth/{login.ts,callback.ts,chooseUsername.ts,logout.ts,bootstrap.ts,contentLogout.ts}
    app/{dashboard.ts,newDrop.ts,editDrop.ts,upload.ts,deleteDrop.ts}
    content/{serve.ts}
  views/*.ejs
  server.ts
  index.ts
tests/
  unit/*.test.ts
  integration/*.test.ts
  e2e/*.spec.ts
  helpers/{app.ts,db.ts,r2.ts,oauth-stub.ts}
docker-compose.yml
drizzle.config.ts
tsconfig.json
package.json
.env.example
Dockerfile
```

**TDD everywhere.** Pure-function modules use Vitest unit tests. DB + R2 modules use Vitest integration tests against real Postgres and MinIO (no mocks). Routes are tested via `fastify.inject()` against a real DB. E2E covers one happy-path browser flow.

**Commit after every task.** Each task ends with a `git add` + `git commit`.

---

## Phase 0 — Project scaffolding

### Task 1: Initialise Node project

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.nvmrc`, `.node-version`

**Step 1: Write `package.json`**

```json
{
  "name": "drops-drops",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

**Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "rootDir": "src",
    "outDir": "dist",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*", "tests/**/*", "drizzle.config.ts"]
}
```

Write a sibling `tsconfig.build.json` that overrides `"noEmit": false` and excludes `tests/**/*`.

**Step 3: Write `.gitignore`**

```
node_modules/
dist/
.env
.env.local
coverage/
playwright-report/
test-results/
.DS_Store
.tmp/
```

**Step 4: Write `.nvmrc` and `.node-version`**

Both files contain the single line `22`.

**Step 5: Install dev dependencies**

```bash
pnpm add -D typescript@^5.6 tsx vitest @types/node eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier
pnpm add fastify pino
```

Run: `pnpm typecheck`
Expected: exits 0 (nothing to compile yet).

**Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json .gitignore .nvmrc .node-version
git commit -m "chore: scaffold Node project"
```

---

### Task 2: Vitest configuration

**Files:**
- Create: `vitest.config.ts`

**Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: { '@': new URL('./src/', import.meta.url).pathname },
  },
});
```

(We use `singleFork` so integration tests don't thrash the shared Postgres/MinIO fixtures.)

**Step 2: Smoke test**

Create `tests/unit/smoke.test.ts`:

```ts
import { expect, it } from 'vitest';
it('runs vitest', () => { expect(1 + 1).toBe(2); });
```

Run: `pnpm test`
Expected: 1 passed.

**Step 3: Commit**

```bash
git add vitest.config.ts tests/unit/smoke.test.ts
git commit -m "chore: configure vitest"
```

---

### Task 3: Local dev Postgres + MinIO via Docker Compose

**Files:**
- Create: `docker-compose.yml`, `.env.example`

**Step 1: `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: drops
      POSTGRES_PASSWORD: drops
      POSTGRES_DB: drops
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U drops"]
      interval: 2s
      timeout: 2s
      retries: 10
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 2s
      timeout: 2s
      retries: 10
```

**Step 2: `.env.example`**

```
DATABASE_URL=postgres://drops:drops@localhost:5432/drops
R2_ENDPOINT=http://localhost:9000
R2_ACCOUNT_ID=minio
R2_ACCESS_KEY_ID=minioadmin
R2_SECRET_ACCESS_KEY=minioadmin
R2_BUCKET=drops
GOOGLE_CLIENT_ID=__fill_me__
GOOGLE_CLIENT_SECRET=__fill_me__
SESSION_SECRET=__generate_64_hex_bytes__
ALLOWED_DOMAIN=drops.global
APP_ORIGIN=http://localhost:3000
CONTENT_ORIGIN=http://localhost:3001
PORT=3000
LOG_LEVEL=info
```

Note: in local dev both "origins" can share one port with distinct hostnames via `/etc/hosts`, but it's easier to listen on two ports. The server will listen on `PORT` for app and `PORT+1` for content locally; in production both sit behind Railway on one port with host-based routing.

**Step 3: Bring up services and confirm**

```bash
docker compose up -d
docker compose ps
```

Expected: both services healthy.

**Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add docker-compose for local postgres and minio"
```

---

### Task 4: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Step 1: Write failing tests**

```ts
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
```

**Step 2: Run tests**

Run: `pnpm test tests/unit/config.test.ts`
Expected: FAIL — module not found.

**Step 3: Install zod**

```bash
pnpm add zod
```

**Step 4: Implement `src/config.ts`**

```ts
import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ALLOWED_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/, 'ALLOWED_DOMAIN must be a bare domain'),
  APP_ORIGIN: z.string().url(),
  CONTENT_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const parsed = Schema.parse(process.env);
  if (parsed.APP_ORIGIN === parsed.CONTENT_ORIGIN) {
    throw new Error('APP_ORIGIN and CONTENT_ORIGIN must differ');
  }
  return parsed;
}

export const config: Config = loadConfig();
```

Note: the bottom-line `config` export is evaluated at import time, which would break unit tests that vary `process.env`. Replace with a lazy accessor:

```ts
let cached: Config | undefined;
export const config = new Proxy({} as Config, {
  get(_, key) { return (cached ??= loadConfig())[key as keyof Config]; },
});
```

**Step 5: Run tests**

Run: `pnpm test tests/unit/config.test.ts`
Expected: all pass.

**Step 6: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add typed config loader"
```

---

## Phase 1 — Pure libraries

### Task 5: Slug validation

**Files:**
- Create: `src/lib/slug.ts`
- Test: `tests/unit/slug.test.ts`

**Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { isValidSlug, suggestSlug, RESERVED_USERNAMES } from '@/lib/slug';

describe('isValidSlug', () => {
  it.each([
    ['a', false], // too short (min 2)
    ['ab', true],
    ['a-b', true],
    ['a--b', true],
    ['-a', false],
    ['a-', false],
    ['AB', false],
    ['a_b', false],
    ['a.b', false],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['0a', true],
    ['a0', true],
  ])('isValidSlug(%p) === %p', (input, expected) => {
    expect(isValidSlug(input)).toBe(expected);
  });
});

describe('suggestSlug', () => {
  it('slugifies an email local-part', () => {
    expect(suggestSlug('Ben.Phillips+tag@example.com')).toBe('ben-phillips-tag');
  });
  it('falls back to "user" for empty result', () => {
    expect(suggestSlug('+@example.com')).toBe('user');
  });
});

describe('RESERVED_USERNAMES', () => {
  it('includes the canonical list', () => {
    for (const r of ['app', 'auth', 'api', 'static', 'admin', '_next', 'health', 'favicon.ico', 'robots.txt']) {
      expect(RESERVED_USERNAMES).toContain(r);
    }
  });
});
```

**Step 2: Run** — FAIL.

**Step 3: Implement**

```ts
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'app', 'auth', 'api', 'static', 'admin', '_next', 'health',
  'favicon.ico', 'robots.txt',
]);

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function suggestSlug(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (cleaned.length >= 2 && isValidSlug(cleaned)) return cleaned;
  return 'user';
}
```

**Step 4: Run** — PASS. **Step 5: Commit.**

```bash
git add src/lib/slug.ts tests/unit/slug.test.ts
git commit -m "feat: slug validation and suggestion"
```

---

### Task 6: MIME lookup

**Files:**
- Create: `src/lib/mime.ts`
- Test: `tests/unit/mime.test.ts`

**Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { mimeFor } from '@/lib/mime';

describe('mimeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['script.js', 'application/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['img.png', 'image/png'],
    ['img.JPG', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
    ['thing.unknown', 'application/octet-stream'],
    ['no-ext', 'application/octet-stream'],
    ['.dotfile', 'application/octet-stream'],
  ])('mimeFor(%p) === %p', (name, mime) => {
    expect(mimeFor(name)).toBe(mime);
  });
});
```

**Step 2: Run** — FAIL.

**Step 3: Implement**

```ts
const MAP: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
};

export function mimeFor(path: string): string {
  const i = path.lastIndexOf('.');
  if (i <= 0 || i === path.length - 1) return 'application/octet-stream';
  const ext = path.slice(i + 1).toLowerCase();
  return MAP[ext] ?? 'application/octet-stream';
}
```

**Step 4: Run** — PASS. **Step 5: Commit.**

```bash
git add src/lib/mime.ts tests/unit/mime.test.ts
git commit -m "feat: mime lookup"
```

---

### Task 7: Path sanitisation

This is security-critical. Plenty of tests.

**Files:**
- Create: `src/lib/path.ts`
- Test: `tests/unit/path.test.ts`

**Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { sanitisePath, PathRejection } from '@/lib/path';

describe('sanitisePath', () => {
  it.each([
    ['foo/bar.html', 'foo/bar.html'],
    ['./foo.html', 'foo.html'],
    ['foo//bar.html', 'foo/bar.html'],
    ['FOO/Bar.HTML', 'FOO/Bar.HTML'], // case preserved
  ])('accepts %p', (input, expected) => {
    expect(sanitisePath(input)).toEqual({ ok: true, path: expected });
  });

  it.each([
    ['', PathRejection.Empty],
    ['/abs/path', PathRejection.AbsolutePath],
    ['C:/x', PathRejection.AbsolutePath],
    ['\\foo', PathRejection.AbsolutePath],
    ['a/../b', PathRejection.ParentSegment],
    ['../b', PathRejection.ParentSegment],
    ['a/./b', PathRejection.DotSegment],
    ['a//.//b', PathRejection.DotSegment],
    ['a/\0/b', PathRejection.ControlChar],
    ['a/b\x01', PathRejection.ControlChar],
    ['.hidden/a', PathRejection.Dotfile],
    ['a/.git/config', PathRejection.Dotfile],
    ['a/.DS_Store', PathRejection.Dotfile],
    ['a/', PathRejection.TrailingSlash],
  ])('rejects %p as %s', (input, reason) => {
    expect(sanitisePath(input)).toEqual({ ok: false, reason });
  });

  it('applies NFC normalisation', () => {
    const combining = 'a\u0301'; // a + combining acute
    const precomposed = '\u00e1'; // á
    const res = sanitisePath(combining);
    expect(res).toEqual({ ok: true, path: precomposed });
  });
});
```

**Step 2: Run** — FAIL.

**Step 3: Implement**

```ts
export enum PathRejection {
  Empty = 'empty',
  AbsolutePath = 'absolute_path',
  ParentSegment = 'parent_segment',
  DotSegment = 'dot_segment',
  ControlChar = 'control_char',
  Dotfile = 'dotfile',
  TrailingSlash = 'trailing_slash',
}

export type PathResult =
  | { ok: true; path: string }
  | { ok: false; reason: PathRejection };

const CONTROL = /[\x00-\x1f\x7f]/;

export function sanitisePath(input: string): PathResult {
  if (!input) return { ok: false, reason: PathRejection.Empty };
  const nfc = input.normalize('NFC');
  if (CONTROL.test(nfc)) return { ok: false, reason: PathRejection.ControlChar };
  if (nfc.startsWith('/') || nfc.startsWith('\\') || /^[A-Za-z]:[/\\]/.test(nfc)) {
    return { ok: false, reason: PathRejection.AbsolutePath };
  }
  if (nfc.endsWith('/')) return { ok: false, reason: PathRejection.TrailingSlash };

  const raw = nfc.split('/');
  const out: string[] = [];
  for (const seg of raw) {
    if (seg === '' || seg === '.') {
      // Collapse `//` and `./`; we only reject when a `.` appears as a non-collapsible segment.
      // But we ONLY accept a leading `./` or collapsible `//`, nothing else.
      continue;
    }
    if (seg === '..') return { ok: false, reason: PathRejection.ParentSegment };
    if (seg.startsWith('.')) return { ok: false, reason: PathRejection.Dotfile };
    out.push(seg);
  }
  if (out.length === 0) return { ok: false, reason: PathRejection.Empty };
  return { ok: true, path: out.join('/') };
}
```

**Re-check: the tests above conflate empty-segment collapse with `./` collapse.** Adjust so `a/./b` is rejected as `DotSegment` (explicit `.` in the middle) but `./foo.html` is accepted (leading `.` collapses). This matches the design's intent: treat `./` prefix as harmless, but a literal `.` segment elsewhere is suspect (likely a signal of hand-crafted paths and worth rejecting).

Simpler approach: reject any `.` or empty segment that is not the leading segment of the input. Update the implementation:

```ts
for (let i = 0; i < raw.length; i++) {
  const seg = raw[i]!;
  if (seg === '') {
    if (i === 0) continue; // leading is impossible because we rejected absolute paths
    return { ok: false, reason: PathRejection.DotSegment };
  }
  if (seg === '.') {
    if (i === 0) continue; // leading `./` is allowed
    return { ok: false, reason: PathRejection.DotSegment };
  }
  if (seg === '..') return { ok: false, reason: PathRejection.ParentSegment };
  if (seg.startsWith('.')) return { ok: false, reason: PathRejection.Dotfile };
  out.push(seg);
}
```

Update the tests: `foo//bar.html` becomes `foo/bar.html` was wrong — under the new rule that's `DotSegment`. Adjust tests to reflect the stricter rule:

```ts
['foo//bar.html', PathRejection.DotSegment]
```

**Step 4: Run** — PASS all tests.

**Step 5: Commit.**

```bash
git add src/lib/path.ts tests/unit/path.test.ts
git commit -m "feat: path sanitisation for drop assets"
```

---

### Task 8: Signed cookies and handoff tokens

**Files:**
- Create: `src/lib/cookies.ts`, `src/lib/handoff.ts`
- Test: `tests/unit/cookies.test.ts`, `tests/unit/handoff.test.ts`

**Step 1: Failing tests for `cookies.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { signCookie, verifyCookie } from '@/lib/cookies';

const key = 'k'.repeat(32);

describe('signCookie/verifyCookie', () => {
  it('round-trips a value', () => {
    const signed = signCookie('hello', key);
    expect(verifyCookie(signed, key)).toBe('hello');
  });
  it('rejects a tampered value', () => {
    const signed = signCookie('hello', key);
    const tampered = 'world' + signed.slice(5);
    expect(verifyCookie(tampered, key)).toBeNull();
  });
  it('rejects a wrong key', () => {
    const signed = signCookie('hello', key);
    expect(verifyCookie(signed, 'x'.repeat(32))).toBeNull();
  });
});
```

**Step 2: Failing tests for `handoff.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { signHandoff, verifyHandoff } from '@/lib/handoff';

const key = 'k'.repeat(32);

describe('handoff token', () => {
  it('round-trips a session id within TTL', () => {
    const token = signHandoff('session-id', key, 60);
    expect(verifyHandoff(token, key)).toEqual({ ok: true, sessionId: 'session-id' });
  });
  it('rejects after expiry', () => {
    const now = Date.now();
    vi.useFakeTimers(); vi.setSystemTime(now);
    const token = signHandoff('session-id', key, 1);
    vi.setSystemTime(now + 2_000);
    expect(verifyHandoff(token, key)).toEqual({ ok: false, reason: 'expired' });
    vi.useRealTimers();
  });
  it('rejects a tampered signature', () => {
    const token = signHandoff('session-id', key, 60);
    const bad = token.slice(0, -2) + 'xx';
    expect(verifyHandoff(bad, key)).toEqual({ ok: false, reason: 'invalid' });
  });
});
```

**Step 3: Run** — FAIL.

**Step 4: Implement `src/lib/cookies.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

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
```

**Step 5: Implement `src/lib/handoff.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type HandoffResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'expired' | 'invalid' };

export function signHandoff(sessionId: string, key: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${sessionId}:${exp}`;
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyHandoff(token: string, key: string): HandoffResult {
  const i = token.indexOf('.');
  if (i < 1) return { ok: false, reason: 'invalid' };
  let payload: string;
  try { payload = Buffer.from(token.slice(0, i), 'base64url').toString('utf8'); }
  catch { return { ok: false, reason: 'invalid' }; }
  const sig = token.slice(i + 1);
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, reason: 'invalid' };
  const [sessionId, expStr] = payload.split(':');
  if (!sessionId || !expStr) return { ok: false, reason: 'invalid' };
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, sessionId };
}
```

**Step 6: Cookie-option helpers**

Browsers refuse to set `Secure` cookies over plain HTTP. In local dev and Playwright we run on `http://`; in production we run on `https://`. Make the flag conditional on the origin's scheme so the same code works in both environments.

Add to `src/lib/cookies.ts`:

```ts
import { config } from '@/config';

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
```

Add a unit test that asserts `secure: false` for `http://…` and `secure: true` for `https://…`.

**Every subsequent task that sets a cookie must call `appCookieOptions` or `contentCookieOptions`** rather than building a `secure: true` object directly. Production still gets `Secure` because `APP_ORIGIN` and `CONTENT_ORIGIN` use `https://` there.

**Step 7: Run** — PASS. **Step 8: Commit.**

```bash
git add src/lib/cookies.ts src/lib/handoff.ts tests/unit/cookies.test.ts tests/unit/handoff.test.ts
git commit -m "feat: signed cookies, handoff tokens, origin-aware cookie options"
```

---

## Phase 2 — Database

### Task 9: Drizzle schema + migrations scaffolding

**Files:**
- Create: `drizzle.config.ts`, `src/db/schema.ts`, `src/db/index.ts`, `src/db/migrate.ts`
- Install: `drizzle-orm`, `drizzle-kit`, `postgres`

**Step 1: Install**

```bash
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

**Step 2: `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

**Step 3: `src/db/schema.ts`**

```ts
import { pgTable, text, uuid, bigint, integer, timestamp, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const allowedEmails = pgTable('allowed_emails', {
  email: text('email').primaryKey(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const pendingLogins = pgTable('pending_logins', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const drops = pgTable('drops', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  currentVersion: uuid('current_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerNameUnique: uniqueIndex('drops_owner_name_unique').on(t.ownerId, t.name),
}));

export const dropVersions = pgTable('drop_versions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  dropId: uuid('drop_id').notNull().references(() => drops.id, { onDelete: 'cascade' }),
  r2Prefix: text('r2_prefix').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  fileCount: integer('file_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idDropUnique: uniqueIndex('drop_versions_id_drop_unique').on(t.id, t.dropId),
}));
```

**Step 4: Generate the migration**

```bash
pnpm db:generate
```

Expected: creates `src/db/migrations/0000_*.sql`.

**Step 5: Manually add the composite FK** — Drizzle's schema helpers cannot express a composite FK back to `drop_versions(id, drop_id)` as of 2026. Edit the generated SQL to append:

```sql
ALTER TABLE drops
  ADD CONSTRAINT fk_current_version_belongs_to_drop
  FOREIGN KEY (current_version, id) REFERENCES drop_versions(id, drop_id)
  DEFERRABLE INITIALLY DEFERRED;
```

(`DEFERRABLE INITIALLY DEFERRED` lets us `INSERT` the new `drops` row and its first `drop_versions` row inside the same transaction without order constraints.)

**Step 6: Seed migration for the allowlist** — add another SQL step in the same migration:

```sql
INSERT INTO allowed_emails (email) VALUES ('ben@ben-phillips.net')
  ON CONFLICT DO NOTHING;
```

**Step 7: `src/db/index.ts`**

```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '@/config';
import * as schema from './schema';

export const sql = postgres(config.DATABASE_URL, { prepare: false });
export const db = drizzle(sql, { schema });
export type DB = typeof db;
```

**Step 8: `src/db/migrate.ts`**

```ts
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './index';

async function main() {
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

**Step 9: Apply**

```bash
cp .env.example .env && nano .env # fill SESSION_SECRET with `openssl rand -hex 32`
pnpm db:migrate
psql "$DATABASE_URL" -c '\dt'
```

Expected: 6 tables (`allowed_emails`, `users`, `sessions`, `pending_logins`, `drops`, `drop_versions`).

**Step 10: Commit.**

```bash
git add drizzle.config.ts src/db package.json pnpm-lock.yaml
git commit -m "feat: database schema and migrations"
```

---

### Task 10: Integration-test helpers (DB + R2)

**Files:**
- Create: `tests/helpers/db.ts`, `tests/helpers/r2.ts`, `tests/helpers/env.ts`

**Step 1: `tests/helpers/env.ts`** — sets up a deterministic test environment.

```ts
export const TEST_ENV = {
  DATABASE_URL: 'postgres://drops:drops@localhost:5432/drops_test',
  R2_ENDPOINT: 'http://localhost:9000',
  R2_ACCOUNT_ID: 'minio',
  R2_ACCESS_KEY_ID: 'minioadmin',
  R2_SECRET_ACCESS_KEY: 'minioadmin',
  R2_BUCKET: 'drops-test',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 's'.repeat(64),
  ALLOWED_DOMAIN: 'drops.global',
  APP_ORIGIN: 'http://drops.localtest.me:3000',
  CONTENT_ORIGIN: 'http://content.localtest.me:3000',
  PORT: '3000',
  LOG_LEVEL: 'silent',
};

for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
```

`localtest.me` resolves to `127.0.0.1` for any subdomain, giving us two distinct hostnames without needing `/etc/hosts`.

**Step 2: `tests/helpers/db.ts`**

```ts
import './env';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';

const rootSql = postgres('postgres://drops:drops@localhost:5432/postgres', { prepare: false });

export async function setupTestDatabase() {
  await rootSql`DROP DATABASE IF EXISTS drops_test WITH (FORCE)`;
  await rootSql`CREATE DATABASE drops_test`;
  const conn = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(conn, { schema });
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  await conn.end();
}

export async function teardown() {
  await rootSql.end();
}
```

Add a global setup file that runs `setupTestDatabase()` once per vitest run. Create `tests/helpers/global-setup.ts`:

```ts
import { setupTestDatabase } from './db';
export default async function globalSetup() { await setupTestDatabase(); }
```

Update `vitest.config.ts`:

```ts
test: {
  // ...
  globalSetup: ['tests/helpers/global-setup.ts'],
  setupFiles: ['tests/helpers/env.ts'],
},
```

**Step 3: `tests/helpers/r2.ts`**

```ts
import './env';
import { S3Client, CreateBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
});

export async function resetBucket() {
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET! }));
    if (list.Contents?.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET!,
        Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) },
      }));
    }
  } catch (e: any) {
    if (e?.name !== 'NoSuchBucket') throw e;
  }
  try { await s3.send(new CreateBucketCommand({ Bucket: process.env.R2_BUCKET! })); }
  catch (e: any) { if (e?.name !== 'BucketAlreadyOwnedByYou') throw e; }
}
```

**Step 4: Install SDK**

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage
```

**Step 5: Smoke test**

Create `tests/integration/helpers.test.ts`:

```ts
import './../helpers/env';
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { resetBucket } from '../helpers/r2';

beforeAll(async () => { await resetBucket(); });

describe('helpers', () => {
  it('talks to Postgres', async () => {
    const rows = await db.select().from(allowedEmails);
    expect(rows.some((r) => r.email === 'ben@ben-phillips.net')).toBe(true);
  });
});
```

Run: `docker compose up -d && pnpm test tests/integration/helpers.test.ts`
Expected: PASS.

**Step 6: Commit.**

```bash
git add tests/helpers vitest.config.ts package.json pnpm-lock.yaml tests/integration/helpers.test.ts
git commit -m "test: integration test helpers for postgres and minio"
```

---

### Task 11: Allowlist service

**Files:**
- Create: `src/services/allowlist.ts`
- Test: `tests/integration/allowlist.test.ts`

**Step 1: Failing tests**

```ts
import '../helpers/env';
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { isEmailAllowed } from '@/services/allowlist';

beforeAll(async () => {
  await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'friend@outside.com' });
});

describe('isEmailAllowed', () => {
  it('allows an email in the table', async () => {
    expect(await isEmailAllowed('friend@outside.com')).toBe(true);
  });
  it('allows an email in the domain', async () => {
    expect(await isEmailAllowed('anyone@drops.global')).toBe(true);
  });
  it('rejects neither', async () => {
    expect(await isEmailAllowed('nope@example.com')).toBe(false);
  });
  it('is case-insensitive on email', async () => {
    expect(await isEmailAllowed('FRIEND@outside.com')).toBe(true);
  });
});
```

**Step 2: Run** — FAIL.

**Step 3: Implement**

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { config } from '@/config';

export async function isEmailAllowed(email: string): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (normalised.endsWith('@' + config.ALLOWED_DOMAIN)) return true;
  const rows = await db.select().from(allowedEmails).where(eq(allowedEmails.email, normalised));
  return rows.length > 0;
}
```

**Step 4: Run** — PASS. **Step 5: Commit.**

```bash
git add src/services/allowlist.ts tests/integration/allowlist.test.ts
git commit -m "feat: allowlist service"
```

---

### Task 12: Sessions service

**Files:**
- Create: `src/services/sessions.ts`
- Test: `tests/integration/sessions.test.ts`

**Step 1: Failing tests**

```ts
import '../helpers/env';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, sessions } from '@/db/schema';
import { createSession, getSessionUser, deleteSession, rollIfStale, SESSION_TTL_SECONDS } from '@/services/sessions';

let userId: string;

beforeAll(async () => {
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'abc' }).returning();
  userId = u!.id;
});

describe('sessions', () => {
  it('creates and reads a session', async () => {
    const sid = await createSession(userId);
    const s = await getSessionUser(sid);
    expect(s?.user.id).toBe(userId);
  });
  it('rolls expiry when stale', async () => {
    const sid = await createSession(userId);
    // Pretend this session was created long ago: set expires_at to 2 hours from now.
    await db.update(sessions)
      .set({ expiresAt: new Date(Date.now() + 2 * 3600_000) })
      .where(eq(sessions.id, sid));
    await rollIfStale(sid);
    const s = await getSessionUser(sid);
    expect(s!.user.id).toBe(userId);
    expect(s!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_SECONDS * 1000 - 10_000);
  });
  it('returns null for expired', async () => {
    const sid = await createSession(userId, -10);
    expect(await getSessionUser(sid)).toBeNull();
  });
  it('deletes', async () => {
    const sid = await createSession(userId);
    await deleteSession(sid);
    expect(await getSessionUser(sid)).toBeNull();
  });
});
```

**Step 2: Run** — FAIL.

**Step 3: Implement**

```ts
import { randomBytes } from 'node:crypto';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const ROLL_WHEN_REMAINING_BELOW_SECONDS = 29 * 24 * 3600; // bump when >24h has passed

export async function createSession(userId: string, ttlOverrideSeconds?: number): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const ttl = ttlOverrideSeconds ?? SESSION_TTL_SECONDS;
  await db.insert(sessions).values({
    id, userId, expiresAt: new Date(Date.now() + ttl * 1000),
  });
  return id;
}

export async function getSessionUser(id: string) {
  const rows = await db.select({ s: sessions, u: users })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  const r = rows[0];
  return r ? { session: r.s, user: r.u } : null;
}

export async function rollIfStale(id: string): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) return;
  const remainingSec = (row.expiresAt.getTime() - Date.now()) / 1000;
  if (remainingSec < ROLL_WHEN_REMAINING_BELOW_SECONDS) {
    await db.update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) })
      .where(eq(sessions.id, id));
  }
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}
```

**Step 4: Run** — PASS. **Step 5: Commit.**

```bash
git add src/services/sessions.ts tests/integration/sessions.test.ts
git commit -m "feat: sessions service"
```

---

### Task 13: Pending-login service

Mirror of Task 12 for `pending_logins`. Methods: `createPendingLogin(identity)`, `consumePendingLogin(id)` (delete-and-return inside one transaction), `PENDING_TTL_SECONDS = 600`.

Follow the same TDD pattern — test create/consume/expire, implement, commit.

**Commit:** `feat: pending-login service`

---

### Task 14: Users service

**Files:**
- Create: `src/services/users.ts`
- Test: `tests/integration/users.test.ts`

Methods:
- `findByEmail(email)`
- `createUser({email, username, name, avatarUrl})` — throws on unique-constraint violation with a typed error
- `isUsernameTaken(username)`
- `findByUsername(username)`

Test: create a user, look up by email and username, reject duplicate username, reject duplicate email.

**Commit:** `feat: users service`

---

## Phase 3 — Infrastructure libs

### Task 15: R2/S3 client wrapper

**Files:**
- Create: `src/lib/r2.ts`
- Test: `tests/integration/r2.test.ts`

**Step 1: Failing tests**

```ts
import '../helpers/env';
import { describe, it, expect, beforeAll } from 'vitest';
import { resetBucket } from '../helpers/r2';
import { putObject, getObject, deletePrefix, listPrefix, headObject, buildR2Endpoint } from '@/lib/r2';
import { Readable } from 'node:stream';

beforeAll(async () => { await resetBucket(); });

describe('buildR2Endpoint', () => {
  it('uses R2_ENDPOINT when set', () => {
    expect(buildR2Endpoint({ endpoint: 'http://localhost:9000', accountId: 'x' }))
      .toBe('http://localhost:9000');
  });
  it('derives production endpoint from R2_ACCOUNT_ID when endpoint is unset', () => {
    expect(buildR2Endpoint({ endpoint: undefined, accountId: 'acct-123' }))
      .toBe('https://acct-123.r2.cloudflarestorage.com');
  });
});

describe('r2', () => {
  it('puts, gets and heads', async () => {
    await putObject('a/b.txt', Buffer.from('hello'), 'text/plain');
    const head = await headObject('a/b.txt');
    expect(head?.contentType).toBe('text/plain');
    const body = await getObject('a/b.txt');
    const text = await streamToString(body!.body);
    expect(text).toBe('hello');
  });
  it('lists and deletes a prefix', async () => {
    await putObject('p/x', Buffer.from('1'));
    await putObject('p/y', Buffer.from('2'));
    await putObject('q/z', Buffer.from('3'));
    const keys = await listPrefix('p/');
    expect(keys.sort()).toEqual(['p/x', 'p/y']);
    await deletePrefix('p/');
    expect(await listPrefix('p/')).toEqual([]);
  });
});

async function streamToString(r: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}
```

**Step 2: Run** — FAIL.

**Step 3: Implement**

```ts
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, NotFound } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { config } from '@/config';

export function buildR2Endpoint(opts: { endpoint?: string; accountId: string }): string {
  if (opts.endpoint) return opts.endpoint; // local MinIO for dev/test
  return `https://${opts.accountId}.r2.cloudflarestorage.com`;
}

export const s3 = new S3Client({
  region: 'auto',
  endpoint: buildR2Endpoint({ endpoint: config.R2_ENDPOINT, accountId: config.R2_ACCOUNT_ID }),
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
  // MinIO requires path-style addressing; R2 supports both but path-style is safer across setups.
  forcePathStyle: Boolean(config.R2_ENDPOINT),
});

export async function putObject(key: string, body: Buffer | Readable, contentType = 'application/octet-stream') {
  await new Upload({
    client: s3,
    params: { Bucket: config.R2_BUCKET, Key: key, Body: body, ContentType: contentType },
  }).done();
}

export async function getObject(key: string) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: config.R2_BUCKET, Key: key }));
    return {
      body: out.Body as Readable,
      contentType: out.ContentType ?? 'application/octet-stream',
      contentLength: out.ContentLength ?? undefined,
      etag: out.ETag ?? undefined,
    };
  } catch (e: any) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function headObject(key: string) {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: config.R2_BUCKET, Key: key }));
    return { contentType: out.ContentType, contentLength: out.ContentLength, etag: out.ETag };
  } catch (e: any) {
    if (e instanceof NotFound || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function listPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: config.R2_BUCKET, Prefix: prefix, ContinuationToken,
    }));
    for (const c of out.Contents ?? []) if (c.Key) keys.push(c.Key);
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

export async function deletePrefix(prefix: string): Promise<void> {
  while (true) {
    const keys = (await listPrefix(prefix)).slice(0, 1000);
    if (keys.length === 0) return;
    await s3.send(new DeleteObjectsCommand({
      Bucket: config.R2_BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }));
  }
}
```

**Step 4: Run** — PASS. **Step 5: Commit.**

```bash
git add src/lib/r2.ts tests/integration/r2.test.ts
git commit -m "feat: r2 client wrapper"
```

---

### Task 16: Drops service (CRUD + atomic version switch)

**Files:**
- Create: `src/services/drops.ts`
- Test: `tests/integration/drops.test.ts`

Methods:
- `findByOwnerAndName(ownerId, name)`
- `listByOwner(ownerId)`
- `listAll(limit, offset)` — returns joined with owner username
- `createDropAndVersion(ownerId, name, version)` — single transaction; inserts drop row, inserts version, sets `current_version`. Uses `ON CONFLICT (owner_id, name)` to surface a typed error.
- `replaceVersion(dropId, ownerId, version)` — single transaction; inserts version, swaps `current_version`; returns `old_version_id`.
- `deleteDrop(dropId, ownerId)` — cascade-deletes the drop (FK cascades delete versions).

Tests:
- create → fetch → listByOwner returns it with version metadata
- replaceVersion returns prior version id; subsequent fetch shows new version
- create with duplicate name rejects
- deleteDrop with wrong owner throws/returns false

**Commit:** `feat: drops service`

---

### Task 17a: Upload service — folder path

**Files:**
- Create: `src/services/upload.ts` (shared types + folder path), `src/services/uploadErrors.ts`
- Test: `tests/integration/upload-folder.test.ts`

**Shared types (in `src/services/upload.ts`):**

```ts
export const UPLOAD_LIMITS = {
  totalBytes: 100 * 1024 * 1024,
  fileCount: 1000,
  perFileBytes: 25 * 1024 * 1024,
  bombRatio: 100,
  bombMinAbsoluteBytes: 10 * 1024 * 1024,
} as const;

export interface UploadedFile { path: string; bytes: number }
export interface UploadResult { files: UploadedFile[]; totalBytes: number; fileCount: number }
```

`uploadErrors.ts` exports a `UploadError` class with a `code` field (`'per_file_size' | 'total_size' | 'file_count' | 'path_rejected' | 'path_collision' | 'invalid_zip' | 'zip_symlink' | 'zip_bomb' | 'zip_too_large'`).

**`uploadFolderParts` design:**

```ts
export async function uploadFolderParts(
  r2Prefix: string,
  parts: AsyncIterable<{ fieldName: string; filename: string; file: Readable; fields: Record<string, string> }>,
): Promise<UploadResult>;
```

Behaviour:
1. Track `totalBytes`, `fileCount`, and a `Set<string>` of canonicalised paths. On any limit breach or collision, throw `UploadError` and `deletePrefix(r2Prefix)` in a `finally` block that runs on error.
2. For each part:
   - Relative path is carried in the multipart part's `filename` — the client sets it via `formData.append('files', file, relativePath)` (File.name is read-only, but the 3rd argument to `FormData.append` sets the multipart filename). Fastify's multipart streams expose this as `part.filename`.
   - Call `sanitisePath(part.filename)`; on failure, throw `UploadError('path_rejected', …)`.
   - If the sanitised path is already in the `Set`, throw `UploadError('path_collision', …)`.
   - Wrap `part.file` in a `PassThrough` that tallies byte count and aborts if per-file or running total limits exceed. Pipe through the counter into an `@aws-sdk/lib-storage` `Upload` with `queueSize: 1`, key `${r2Prefix}${sanitisedPath}`, `ContentType` from `mimeFor(sanitisedPath)`.
3. Return `{ files, totalBytes, fileCount }` on success.

**Tests:**

```ts
it('uploads a folder to R2', async () => { /* assert R2 prefix contents */ });
it('rejects parent-segment paths and cleans up', async () => { /* assert listPrefix returns [] */ });
it('rejects dotfiles', async () => { /* .git/config → path_rejected */ });
it('rejects symlink content (OS-agnostic: cannot test; skip)');
it('enforces per-file size', async () => { /* 26 MB → per_file_size */ });
it('enforces total size', async () => { /* 12 × 9 MB → total_size */ });
it('enforces file count', async () => { /* 1001 × 1 byte → file_count */ });
it('rejects post-canonicalisation collision', async () => {
  // Two parts whose sanitised paths match (e.g. `a/b` and `./a/b` after NFC)
});
```

`fakeParts` is a helper in `tests/helpers/multipart.ts` returning an `AsyncIterable` matching the signature used by Fastify's multipart plugin.

**Commit:** `feat: upload service — folder path`

---

### Task 17b: Upload service — zip path

**Files:**
- Modify: `src/services/upload.ts`
- Test: `tests/integration/upload-zip.test.ts`
- Install: `yauzl` (runtime), `yazl` (dev, for fixture generation)

```bash
pnpm add yauzl
pnpm add -D @types/yauzl yazl @types/yazl
```

**Critical correction.** `yauzl` requires random access to the archive (it reads the central directory from the tail). It cannot consume a plain stream. The folder-vs-zip multipart limits also diverge:

- Folder path: each multipart file ≤ 25 MB (per-file cap), total ≤ 100 MB.
- Zip path: one multipart file (the whole zip) up to 100 MB; decompressed entries ≤ 25 MB each; decompressed total ≤ 100 MB.

So the zip path needs a *different* multipart configuration than the folder path. Do this by registering two multipart scopes on the Fastify instance (`@fastify/multipart` lets you call `request.parts()` with per-request options), or branch on `upload_type` at the route level before consuming the body. See Task 31 for the exact wiring.

**`uploadZip` design:**

```ts
export async function uploadZip(r2Prefix: string, stream: Readable): Promise<UploadResult>;
```

1. Spool the incoming stream to a temporary file (use `node:os` `tmpdir()` + a random name; clean up in `finally`).
2. While spooling, enforce a hard cap at `UPLOAD_LIMITS.totalBytes + 1` bytes; abort with `UploadError('zip_too_large', …)` once the cap is exceeded. Counter sits between the stream and the file.
3. Open the spooled file with `yauzl.open(path, { lazyEntries: true, strictFileNames: true })`.
4. First pass: enumerate entries (without reading data), applying sanitisation and symlink rejection:
   - Skip directory entries (those ending with `/`).
   - Extract Unix mode from `entry.externalFileAttributes >>> 16` and reject if `(mode & 0o170000) === 0o120000` (symlink).
   - Run `sanitisePath(entry.fileName)`; collect rejections.
   - Track `Set<string>` for collision detection (after sanitisation + unwrap).
   - Detect single-root-unwrap: if all sanitised entry paths share an identical first segment, strip it.
5. Second pass: stream each entry's decompressed contents into `@aws-sdk/lib-storage` `Upload`. Enforce:
   - Per-entry decompressed bytes ≤ `perFileBytes`.
   - Running total decompressed bytes ≤ `totalBytes`.
   - Bomb guard: abort if a single entry's decompressed bytes exceed `bombMinAbsoluteBytes` AND the entry's `compressedSize` × `bombRatio` is smaller than decompressed bytes seen so far.
6. On any failure, `deletePrefix(r2Prefix)` in `finally`. Always remove the spool file.

**Tests:**

```ts
it('unwraps a single-root zip', async () => { /* my-site/ prefix stripped */ });
it('rejects zip symlink entries', async () => {
  // Use yazl to write a symlink entry via addBuffer with external mode 0o120777<<16
});
it('rejects a zip too large to spool', async () => { /* > 100 MB → zip_too_large */ });
it('blocks a zip bomb', async () => {
  // yazl + pre-compressed highly-repetitive buffer so compressedSize * ratio < decompressed
});
it('rejects post-canonicalisation path collision in zip', async () => {
  // Two entries whose sanitised paths match
});
it('rejects parent-segment paths in zip', async () => {});
it('rejects corrupt archives', async () => {
  // Truncated zip → invalid_zip
});
it('cleans up R2 on failure mid-way', async () => {
  // Two entries; second one exceeds per-file — verify R2 prefix is empty after throw
});
```

**Commit:** `feat: upload service — zip path with spool + yauzl`

---

### Task 17c: Upload service — end-to-end failure + concurrency tests

**Files:**
- Test: `tests/integration/upload-concurrency.test.ts`

This task adds integration-level tests for scenarios spanning both upload paths:

```ts
it('two concurrent folder uploads to the same drop: later commit wins cleanly', async () => {
  // Concurrently call uploadFolderParts + drop-version commit for the same drop.
  // Assert: the winning R2 prefix matches drops.current_version; the losing prefix
  // is either fully GC'd or queued for GC; no DB inconsistency.
});

it('mid-upload R2 write failure leaves no objects behind', async () => {
  // Inject a synthetic failure by having the S3 client throw on the Nth PutObject.
  // Use a Proxy around `s3` exported from `@/lib/r2`.
  // Assert: listPrefix(r2Prefix) returns [].
});
```

(Concurrency at the upload layer is only half the story; the other half is in Task 31 — the advisory lock around drop creation/version swap.)

**Commit:** `test: upload cleanup and concurrency`

---

### Task 18: OAuth client (OpenID Connect / Google)

**Files:**
- Create: `src/lib/oauth.ts`
- Test: `tests/unit/oauth.test.ts` (covers just URL construction and token verification mock); full flow tested at the route level in Phase 5.
- Install: `openid-client`

```bash
pnpm add openid-client
```

Methods:
- `async buildAuthUrl({ state, nonce, next }) → string` — returns the Google authorize URL with `response_type=code`, `scope=openid email profile`, correct `redirect_uri`.
- `async exchangeCode({ code, state, expectedNonce }) → { email, emailVerified, name, avatarUrl }` — exchanges code for tokens at Google and verifies the ID token (signature, iss, aud, exp, nonce).

Use `openid-client`'s issuer discovery against `https://accounts.google.com`.

**Commit:** `feat: google oauth client`

---

### Task 19: Garbage collection service

**Files:**
- Create: `src/services/gc.ts`
- Test: `tests/integration/gc.test.ts`

Methods:
- `gcVersion(versionId)` — deletes R2 prefix for that version, then deletes the `drop_versions` row. Idempotent.
- `sweepOrphans()` — finds `drop_versions` rows not referenced as any drop's `current_version` and runs `gcVersion` on each.

Tests:
- Insert two versions, one orphaned. Run `sweepOrphans()`. Assert orphan gone from R2 and DB; current version untouched.
- `gcVersion` twice is harmless.

**Commit:** `feat: garbage collection`

---

## Phase 4 — HTTP server

### Task 20: Server bootstrap + host routing

**Files:**
- Create: `src/server.ts`, `src/index.ts`, `src/middleware/host.ts`
- Test: `tests/integration/server-boot.test.ts`

```bash
pnpm add fastify @fastify/cookie @fastify/formbody @fastify/multipart @fastify/view @fastify/rate-limit ejs
```

**`src/server.ts`:**

```ts
import Fastify, { FastifyInstance } from 'fastify';
import cookies from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import view from '@fastify/view';
import ejs from 'ejs';
import { config } from '@/config';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 110 * 1024 * 1024, // slightly above upload cap
  });

  await app.register(cookies, { secret: config.SESSION_SECRET });
  await app.register(formbody);
  // Multipart is registered without per-request limits here. The upload route
  // (Task 31) consumes the body with request-scoped limits that branch on
  // upload_type: folder path caps each part at 25 MB; zip path allows a single
  // 100 MB part. Fastify's multipart plugin supports per-request `request.parts({ limits })`.
  await app.register(multipart, { limits: { fieldNameSize: 200, fieldSize: 1024 } });
  await app.register(view, { engine: { ejs }, root: 'src/views' });

  // Host routing: app-host routes first, then content-host routes.
  app.decorateRequest('hostKind', 'app');
  app.addHook('onRequest', async (req) => {
    const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    const appHost = new URL(config.APP_ORIGIN).hostname;
    const contentHost = new URL(config.CONTENT_ORIGIN).hostname;
    if (host === contentHost) (req as any).hostKind = 'content';
    else if (host === appHost) (req as any).hostKind = 'app';
    else (req as any).hostKind = 'unknown';
  });

  app.get('/health', async () => ({ ok: true }));

  // Register route modules (added in later tasks).

  return app;
}
```

**`src/index.ts`:**

```ts
import { buildServer } from './server';
import { config } from './config';

const app = await buildServer();
await app.listen({ host: '0.0.0.0', port: config.PORT });
```

**Tests:**
- Boot the server via `buildServer()`, inject `GET /health`, expect `{ ok: true }`.
- Inject with `host: 'evil.example'`, expect 404 once host guard is installed (next task).

**Commit:** `feat: server bootstrap and host detection`

---

### Task 21: Host-scoped route registration helper

**Files:**
- Modify: `src/server.ts`
- Create: `src/middleware/host.ts`

Expose `onAppHost` and `onContentHost` plugin helpers:

```ts
export function onAppHost(plugin: FastifyPluginAsync) {
  return async (app: FastifyInstance) => {
    app.addHook('onRequest', async (req, reply) => {
      if ((req as any).hostKind !== 'app') reply.callNotFound();
    });
    await app.register(plugin);
  };
}
export function onContentHost(plugin: FastifyPluginAsync) { /* symmetric */ }
```

In `buildServer`, register the app routes via `await app.register(onAppHost(appRoutes))` and content routes via `await app.register(onContentHost(contentRoutes))`. `appRoutes` and `contentRoutes` are placeholders for now; later tasks slot route modules in.

Tests: request with wrong host gets 404; right host reaches its registered route.

**Commit:** `feat: host-scoped route registration`

---

### Task 22: Auth middleware

**Files:**
- Create: `src/middleware/auth.ts`
- Test: `tests/integration/auth-middleware.test.ts`

Exports:
- `requireAppSession` — Fastify `preHandler` that reads `drops_session` cookie, loads the session + user, calls `rollIfStale`, and either attaches `req.user` or 302s to `${APP_ORIGIN}/auth/login?next=<current url>`.
- `requireContentSession` — symmetric for `drops_content_session`; on miss, 302 to `${APP_ORIGIN}/auth/login?next=<content url>`.
- Exempt-route whitelisting is done at route-registration time (some routes simply don't install the hook).

Tests:
- No cookie → 302 to login with encoded `next`.
- Expired session → cookie cleared, 302 to login.
- Valid session → handler runs with `req.user` populated.
- Stale-but-valid session bumps `expires_at`.

**Commit:** `feat: auth middleware`

---

### Task 23: CSRF token issuance + validation

**Files:**
- Create: `src/lib/csrf.ts` (issuance + validation helpers), `src/middleware/csrf.ts` (Fastify plugin)
- Test: `tests/unit/csrf.test.ts`, `tests/integration/csrf.test.ts`

**Approach:** session-bound double-submit with exact-origin check. Two modes:

- **Authenticated mode** — token is bound to the session id via HMAC. A CSRF cookie from session A cannot be replayed against a request authenticated as session B because the bound session id won't match.
- **Pre-session mode** — used only by `/auth/choose-username` (POST). The token is bound to the `pending_login` id carried in the `pending_login` cookie. Same HMAC scheme, different binding.

**`src/lib/csrf.ts` API:**

```ts
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@/config';

/** Issues a token bound to a specific context id (session id or pending-login id). */
export function issueCsrfToken(contextId: string): string {
  const nonce = randomBytes(24).toString('base64url');
  const sig = createHmac('sha256', config.SESSION_SECRET)
    .update(contextId + ':' + nonce).digest('base64url');
  return `${nonce}.${sig}`;
}

/** Verifies the submitted token was issued for the given context id. */
export function verifyCsrfToken(contextId: string, token: string): boolean {
  const i = token.indexOf('.');
  if (i < 1) return false;
  const nonce = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = createHmac('sha256', config.SESSION_SECRET)
    .update(contextId + ':' + nonce).digest('base64url');
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

The submitted token must match the cookie value exactly AND verify for the current context id. Double-submit is still the mechanism; binding is the reinforcement.

**Origin check (exact):**

```ts
import { config } from '@/config';

export function originMatches(header: string | undefined): boolean {
  if (!header) return false;
  try {
    const a = new URL(header);
    const b = new URL(config.APP_ORIGIN);
    return a.protocol === b.protocol && a.host === b.host;
  } catch { return false; }
}
```

No `startsWith`, no substring match — scheme and host must match exactly against `APP_ORIGIN`.

**Issuance flow (GET handlers that render forms):**

```ts
import { appCookieOptions } from '@/lib/cookies';

app.addHook('preHandler', async (req, reply) => {
  if (req.method !== 'GET') return;
  const contextId = (req as any).session?.id ?? (req as any).pendingLogin?.id;
  if (!contextId) return; // nothing to bind to yet
  const token = issueCsrfToken(contextId);
  reply.setCookie('drops_csrf', token, appCookieOptions({ httpOnly: false }));
  (req as any).csrfToken = token;
});
```

Tokens rotate on every form render. That's fine — the cookie is replaced each time, and a stale embedded token only fails if the user left a tab open across multiple renders (acceptable trade-off for simplicity).

**Validation flow (state-changing methods):**

```ts
app.addHook('preHandler', async (req, reply) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  if (req.routeOptions.config?.skipCsrf) return;

  const headerOrigin = (req.headers.origin as string | undefined)
    ?? (req.headers.referer as string | undefined);
  if (!originMatches(headerOrigin)) return reply.code(403).send('bad_origin');

  const cookie = req.cookies.drops_csrf ?? '';
  const submitted = (req.headers['x-csrf-token'] as string | undefined)
    ?? (req.body as any)?._csrf
    ?? '';
  if (!cookie || !submitted || cookie !== submitted) {
    return reply.code(403).send('bad_csrf');
  }

  const contextId = (req as any).session?.id ?? (req as any).pendingLogin?.id;
  if (!contextId) return reply.code(403).send('no_csrf_context');
  if (!verifyCsrfToken(contextId, submitted)) return reply.code(403).send('bad_csrf');
});
```

Because the token is HMAC'd with the context id, a token issued for session A cannot validate against session B even if the attacker can somehow plant cookies — the signature would not match.

**Exempt routes** (`{ config: { skipCsrf: true } }`):
- `GET /auth/callback` — Google redirects the browser (GET) carrying `code` and `state`. The signed `oauth_state` cookie + `state` parameter is the CSRF equivalent here. GET handlers don't pass through the validation middleware anyway; the exemption is belt-and-braces in case a future refactor re-routes this.

**Tests:**
- `GET /app/drops/new` sets `drops_csrf` with a session-bound token; template contains matching value.
- `POST` with valid token bound to the *same* session → passes.
- `POST` with a valid-signature token bound to a *different* session → 403 `bad_csrf`.
- `POST` with `Origin: https://drops.example.evil.com` → 403 `bad_origin` (exact-match, so this fails).
- `POST` with missing `Origin` and `Referer` → 403 `bad_origin`.
- `POST /auth/choose-username` with a token bound to the pending-login id → passes.

**Commit:** `feat: session-bound CSRF with exact-origin check`

---

## Phase 5 — Auth routes

### Task 24: `/auth/login`

**Files:**
- Create: `src/routes/auth/login.ts`
- Test: `tests/integration/auth-login.test.ts`

Handler:
1. Generate `state` and `nonce` (32 random bytes each, base64url).
2. Read optional `?next=` param; validate against the `APP_ORIGIN`/`CONTENT_ORIGIN` allowlist. Default to `${APP_ORIGIN}/app`.
3. Build `oauth_state` payload = `{ state, nonce, next }`, serialise to JSON, sign via `signCookie`, set on app host with `HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth`.
4. Redirect 302 to Google authorize URL.

Tests:
- `GET /auth/login` → 302 to `accounts.google.com` with `state`/`nonce` present; `oauth_state` cookie set.
- `GET /auth/login?next=https://evil.com` → 302 with `next` clamped to default.

**Commit:** `feat: /auth/login`

---

### Task 25: `/auth/callback`

**Files:**
- Create: `src/routes/auth/callback.ts`
- Test: `tests/integration/auth-callback.test.ts`
- Create: `tests/helpers/oauth-stub.ts`

This is the gnarliest auth task. **Write an OAuth stub** rather than hitting real Google:

```ts
// tests/helpers/oauth-stub.ts
// Overrides the exchange step for tests by monkey-patching `src/lib/oauth.ts`'s
// exported `exchangeCode` via `vi.mock`, OR by running a tiny Fastify instance
// that speaks Google's token/JWKS endpoints.
```

Pick the mocking approach for speed; a full fake-Google HTTP server is nicer but unnecessary for plan scope.

Handler:
1. Read `oauth_state` cookie, verify signature, parse JSON. If missing or tampered, render "login failed".
2. Validate `code` and `state` query params; compare `state` with cookie value.
3. Call `exchangeCode({ code, expectedNonce: cookie.nonce })`.
4. Check `emailVerified === true`. Reject otherwise (render "not authorised").
5. Check `isEmailAllowed(email)`. Reject otherwise.
6. Look up user by email:
   - If exists: `createSession(user.id)`, set `drops_session` cookie, then 302 to content-host `/auth/bootstrap?token=<handoff>&next=<target>`.
   - If not: create a `pending_logins` row, sign a `pending_login` cookie with the row id, 302 to `/auth/choose-username`.
7. Clear the `oauth_state` cookie on exit.

Tests:
- Happy path: stub returns known identity → session created, bootstrap redirect issued.
- Unverified email → rejected.
- Not allowlisted → rejected.
- Missing state cookie → rejected.
- New user → pending login + redirect to choose-username.

**Commit:** `feat: /auth/callback with state/nonce and allowlist`

---

### Task 26: `/auth/choose-username` (GET + POST)

**Files:**
- Create: `src/routes/auth/chooseUsername.ts`, `src/views/chooseUsername.ejs`, `src/views/_layout.ejs`
- Test: `tests/integration/choose-username.test.ts`

Handler behaviour exactly as in the design (section "Auth Flow" step 6). Validate slug and reserved set; on success, in one transaction: insert `users`, delete `pending_logins`, `createSession`, set cookies, redirect through the content bootstrap.

Tests:
- `GET` without pending cookie → 302 to login.
- `GET` with valid pending cookie renders form with suggested slug.
- `POST` with reserved slug → 400 with error message.
- `POST` with taken slug → re-renders with error.
- `POST` with valid new slug → user + session created, 302 to bootstrap.

**Commit:** `feat: /auth/choose-username`

---

### Task 27: Content-host `/auth/bootstrap`

**Files:**
- Create: `src/routes/auth/bootstrap.ts`
- Test: `tests/integration/auth-bootstrap.test.ts`

Handler:
1. Parse `token` query param, call `verifyHandoff`. On failure, 400 "invalid or expired".
2. Look up session by `sessionId`. If missing/expired, 400.
3. Set `drops_content_session` cookie on the content host with the session id.
4. Validate `next`: origin must equal `APP_ORIGIN` or `CONTENT_ORIGIN`; else use `${APP_ORIGIN}/app`.
5. 302 to `next`.

Tests:
- Valid token → cookie set, redirect to validated next.
- Expired token → 400.
- Tampered next → redirected to default.

**Commit:** `feat: content-host /auth/bootstrap`

---

### Task 28: Logout chain

**Files:**
- Create: `src/routes/auth/logout.ts`, `src/routes/auth/contentLogout.ts`
- Test: `tests/integration/auth-logout.test.ts`

App-host `POST /auth/logout`:
1. Require CSRF.
2. `deleteSession(req.session.id)`; clear `drops_session` cookie.
3. 302 to `${CONTENT_ORIGIN}/auth/logout?next=${APP_ORIGIN}/auth/goodbye`.

Content-host `GET /auth/logout`:
1. Clear `drops_content_session`.
2. Validate and redirect to `next` (same allowlist as bootstrap).

Tests:
- POST logout clears both cookies and ends on goodbye page.

**Commit:** `feat: logout chain`

---

## Phase 6 — App routes

### Task 29: Dashboard `/app`

**Files:**
- Create: `src/routes/app/dashboard.ts`, `src/views/dashboard.ejs`
- Test: `tests/integration/dashboard.test.ts`

Handler:
- `requireAppSession` preHandler.
- Load `yourDrops = drops.listByOwner(user.id)` and `allDrops = drops.listAll(25, offset)`.
- Render.

View: two simple tables. Nav shows the username and a logout form (CSRF token included). We store `avatar_url` in the schema but do not render it in v1 — displaying a Google-hosted image would require broadening the CSP `img-src` to include `https://lh3.googleusercontent.com` or proxying avatars. YAGNI for v1; revisit if the UI calls for it.

Tests:
- Unauthenticated → 302 to login.
- Authenticated with no drops → renders empty state.
- After creating a drop, dashboard shows it under "Your drops" and "All drops".

**Commit:** `feat: /app dashboard`

---

### Task 30: `/app/drops/new` (form)

**Files:**
- Create: `src/routes/app/newDrop.ts`, `src/views/newDrop.ejs`
- Test: `tests/integration/new-drop-form.test.ts`

Handler:
- `GET /app/drops/new` renders a form with a name input and a drag-drop zone. Client-side JavaScript lives in `src/views/static/new-drop.js` (served via a static `/app/static` branch added in Task 33).

The form submits directly to `POST /app/drops/:name/upload?upload_type=folder|zip`. The client:
- Reads the name input, chooses `upload_type` based on whether the user dropped a folder or a single `.zip` file, and appends it to the URL.
- For folders: walks the tree via `webkitGetAsEntry` producing `{ relativePath, file }` entries. `File.name` is read-only in browsers, so the relative path is passed as the third argument to `FormData.append`, which sets the multipart part's filename:

  ```js
  const fd = new FormData();
  for (const { relativePath, file } of entries) {
    fd.append('files', file, relativePath);
  }
  ```

  The server reads `part.filename` to get `relativePath` back.
- For zips: `fd.append('file', zipFile, zipFile.name)`.
- Includes the CSRF token in the `x-csrf-token` header.
- POSTs `multipart/form-data` using `XMLHttpRequest` so `.upload.onprogress` can drive a progress bar (Fetch streams-by-upload are still uneven across browsers in 2026).

Tests (server-side rendering only): page renders with CSRF token and correct form action URL.

**Commit:** `feat: /app/drops/new form`

---

### Task 31: `POST /app/drops/:name/upload` (create-or-update)

**Files:**
- Create: `src/routes/app/upload.ts`
- Test: `tests/integration/upload-endpoint.test.ts`

**Concurrency model: "last commit wins" without locking the upload.**

Holding a lock across the full upload would pin a DB connection for potentially tens of seconds. Instead, we let uploads run concurrently and rely on atomic DB operations at commit time. Two scenarios:

Key decision: **R2 prefixes are keyed on `versionId` alone**, not on `${dropId}/${versionId}`. Version ids are globally unique, and nothing in the system ever addresses a drop's prefix as a whole (GC walks by version). This means the upload doesn't need to know the `dropId` in advance — which removes an ordering dependency between the create race and the R2 writes.

- **Create race** (two uploads for a drop name that doesn't exist yet): each upload generates its own `versionId` and writes to `drops/${versionId}/`. At commit, both try `INSERT INTO drops ... ON CONFLICT (owner_id, name) DO NOTHING`. The winner's row is the one everyone uses afterward. Both uploads then insert a `drop_versions` row keyed on the winning `drops.id`. The `SELECT ... FOR UPDATE` on that row orders the `current_version` swap. Last swap wins; earlier version becomes orphaned and is GC'd by the sweep.
- **Update race** (two uploads to an existing drop): each uploads to its own `drops/${versionId}/` prefix. At commit, a `SELECT ... FOR UPDATE` on the `drops` row serialises the swap. First transaction swaps, second reads the latest `current_version` (which is the first's new version) as its `oldVersionId`, swaps again. The penultimate version orphans and is GC'd on schedule.

**Handler:**

1. `requireAppSession` + CSRF check.
2. Validate `:name` against `isValidSlug`.
3. Read `upload_type` from the URL as `?upload_type=folder|zip` (query parameter, not a form field). This makes it available before the multipart body is parsed. Reject anything else with 400.
4. Set multipart limits by calling `request.parts({ limits })` at handler start:
   - `upload_type=folder` → `{ fileSize: 25 MB, files: 1000, parts: 1010 }`
   - `upload_type=zip` → `{ fileSize: 100 MB, files: 1, parts: 10 }`
   Invalid `upload_type` → 400 before touching the body.
5. Allocate `versionId = randomUUID()`, `r2Prefix = drops/${versionId}/`.
6. Consume the multipart stream. If `upload_type=zip`, feed the single file stream to `uploadZip(r2Prefix, …)`; otherwise iterate file parts into `uploadFolderParts(r2Prefix, …)`. The upload services throw `UploadError` on any failure and clean up R2 themselves.
7. On `UploadError`, return 400 with the error code in the body. No DB writes have happened.
8. On upload success, commit in a single transaction:

   ```sql
   -- Atomic create-or-get of the drops row (this user, this name)
   WITH upsert AS (
     INSERT INTO drops (owner_id, name)
     VALUES ($user_id, $name)
     ON CONFLICT (owner_id, name) DO NOTHING
     RETURNING id, current_version
   )
   SELECT id, current_version FROM upsert
   UNION ALL
   SELECT id, current_version FROM drops
     WHERE owner_id = $user_id AND name = $name
     LIMIT 1;
   -- First row returned is what we got (either just-inserted or pre-existing).

   -- Lock the drops row to serialise the version swap.
   SELECT id, current_version FROM drops WHERE id = $drop_id FOR UPDATE;

   -- Insert the version.
   INSERT INTO drop_versions (id, drop_id, r2_prefix, byte_size, file_count)
   VALUES ($version_id, $drop_id, $r2_prefix, $byte_size, $file_count);

   -- Swap current_version and capture the old one.
   UPDATE drops SET current_version = $version_id, updated_at = now()
     WHERE id = $drop_id
     RETURNING current_version AS new_version;
   -- (Old version captured from the FOR UPDATE read above.)
   ```

9. After commit, if the captured `oldVersionId` is not NULL, enqueue `gcVersion(oldVersionId)` via `setImmediate` with error logging. The hourly sweep (Task 37) retries any failures.
10. 302 to `/app/drops/${name}`.

**Tests:**
- Create a new drop from a folder upload; assert R2 prefix populated at `drops/${versionId}/`; `drops.current_version` set; dashboard shows the drop.
- Create a drop with the **same name as another user's existing drop** → succeeds; both drops coexist; each resolves under its own owner's username.
- Second upload to the same owner+name drop; new files served; old prefix gone after GC.
- Upload with a `..` path → 400; no `drops` row created (if first upload); existing drop unchanged (if re-upload).
- Upload exceeding total size → 400; R2 prefix empty.
- `?upload_type=zip` with a zip body → zip path taken.
- Upload of zip with single-root directory → root unwrapped in R2.
- **Concurrent create race** (two uploads for a new name): both succeed at the upload step; one wins the `INSERT ON CONFLICT`; both end up with a `drop_versions` row against the same `drops.id`; `current_version` is the one whose `UPDATE` committed last; the earlier version becomes orphaned and is GC'd by the sweep. Verify final `current_version` is one of the two submitted version ids, and that no R2 objects survive the sweep under the losing version's prefix.
- **Concurrent update race** (two uploads to an existing drop): `SELECT FOR UPDATE` serialises the swap. Verify the final `current_version` matches the later-committed transaction, and the other two version prefixes (pre-existing + first commit) are GC'd.

**Commit:** `feat: upload endpoint with create-or-update`

---

### Task 32: `/app/drops/:name` (edit page) + `DELETE /app/drops/:name`

**Files:**
- Create: `src/routes/app/editDrop.ts`, `src/routes/app/deleteDrop.ts`, `src/views/editDrop.ejs`
- Test: `tests/integration/edit-delete.test.ts`

Edit page: shows current version info; has a "Replace contents" drag-drop zone (same client JS as `new`) and a "Delete drop" form (method=POST, `_method=DELETE` shim or just `POST /app/drops/:name/delete`).

Delete handler: CSRF check, owner check, single transaction reading all the drop's `drop_versions.r2_prefix` values, removing the `drops` row (cascades to `drop_versions`), then fire-and-forget a `deletePrefix()` call for each recorded prefix.

Tests:
- Non-owner GET → 403.
- Owner GET renders; shows current version metadata and "View at" link to the content origin.
- Delete removes DB row; R2 prefix cleared.

**Commit:** `feat: edit and delete drop`

---

### Task 33: Static assets for `/app/static`

**Files:**
- Create: `src/routes/app/static.ts`, `src/views/static/new-drop.js`, `src/views/static/style.css`
- Install: `@fastify/static`

```bash
pnpm add @fastify/static
```

Register `@fastify/static` scoped to `/app/static` on the app host, pointing at `src/views/static`.

The client JS handles both folder and zip flows. Pseudocode sketch in the file itself; include real implementation for the drag-drop → multipart POST path. Tests are not required for this static directory beyond a `GET /app/static/new-drop.js` smoke test returning 200.

**Commit:** `feat: static assets for app UI`

---

## Phase 7 — Content routes

### Task 34: Content-host drop serving

**Files:**
- Create: `src/routes/content/serve.ts`
- Test: `tests/integration/content-serve.test.ts`

Handler on `GET /:username/:dropname/*` (content host only):
1. `requireContentSession` preHandler.
2. Look up user by `username`; drop by `(owner.id, dropname)`; version by `currentVersion`; 404 on any miss.
3. Trailing-slash: `GET /u/d` (no trailing slash, empty splat) → 301 to `/u/d/`.
4. Resolve path:
   - `rest = req.params['*']` — guaranteed free of scheme/host by Fastify.
   - `if (rest === '' || rest.endsWith('/')) rest += 'index.html'`.
   - Sanitise `rest` using the same rules as upload (reject `..`, absolute, control, dotfile).
5. Fetch `prefix + rest` from R2 via `getObject`. On 404, if `rest` doesn't end in `.html` or `/`, try `prefix + rest + '/index.html'`. Else 404 plain text.
6. Handle `If-None-Match` against R2 `ETag` → 304.
7. Stream body; set `Content-Type` from R2 metadata; `Cache-Control: private, max-age=0, must-revalidate`; pass through `ETag` and `Content-Length`.
8. Support `HEAD` with same logic, no body.

Tests (using a drop created via the upload service directly, no browser):
- Simple `GET /u/d/` returns `index.html`.
- `GET /u/d/about` (no extension, directory containing `index.html`) returns that index.
- `GET /u/d/../../../etc/passwd` returns 404 (router-normalised path shouldn't even reach us, but double-check).
- Unauthenticated request → 302 to `${APP_ORIGIN}/auth/login?next=...`.
- `If-None-Match` matching R2 ETag → 304.

**Commit:** `feat: content-host drop serving`

---

## Phase 8 — Ops, security, E2E

### Task 35: Security headers

**Files:**
- Modify: `src/server.ts`
- Install: `@fastify/helmet`

```bash
pnpm add @fastify/helmet
```

On app host: register helmet with a strict CSP (`default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';`), `Strict-Transport-Security`, `X-Frame-Options: DENY`.

On content host: helmet with `contentSecurityPolicy: false` and `frameguard: false` (drops are user-controlled). Keep `Strict-Transport-Security`.

Test: `GET /app` returns CSP header; `GET /u/d/` does not.

**Commit:** `feat: security headers`

---

### Task 36: Rate limiting

**Files:**
- Modify: `src/server.ts`
- Register `@fastify/rate-limit` globally at a generous ceiling (120 req/min/IP), with tighter overrides on:
  - `/auth/login`, `/auth/callback`, `/auth/choose-username`: 20/min/IP.
  - `/app/drops/*/upload`: 10/min/user (keyed by session or IP).

Test: hammer `/auth/login` 21 times in a test → last gets 429.

**Commit:** `feat: rate limiting`

---

### Task 37: Scheduled orphan sweep

**Files:**
- Create: `src/services/scheduler.ts`
- Modify: `src/index.ts`

In-process `setInterval` running `sweepOrphans()` every hour, with a leading call on startup. Log exceptions; don't crash the process.

Test: add a unit test that the schedule registers and clears correctly; real sweep tested in Task 19.

**Commit:** `feat: hourly orphan sweep`

---

### Task 38: Deep health check

**Files:**
- Modify: `src/routes/health.ts` (create if missing)

`GET /health` → 200 `{ db: 'ok', r2: 'ok' }` after a `SELECT 1` and an R2 `HeadBucket`. Return 503 if either fails.

Test: integration test covers the happy path; override `db` to throw for the failure path.

**Commit:** `feat: deep health check`

---

### Task 38a: Structured request logging

**Files:**
- Modify: `src/server.ts`
- Test: `tests/integration/logging.test.ts`

The design requires every log line to carry `request_id` and (when authenticated) `user_id`. Fastify already generates a request id; rename the log label and attach `user_id` after auth.

```ts
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  genReqId: () => randomUUID(),
  requestIdLogLabel: 'request_id',
  requestIdHeader: false,
});

// After auth middleware has attached req.user:
app.addHook('preHandler', async (req) => {
  const u = (req as any).user;
  if (u) req.log = req.log.child({ user_id: u.id });
});
```

Test: capture logs via a Pino `destination` stream in-memory, issue a request with a session cookie, assert the emitted log object contains both `request_id` and `user_id`.

**Commit:** `feat: structured request logging with request_id and user_id`

---

### Task 39: Playwright E2E

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/drop.spec.ts`, `tests/e2e/fixtures/site/{index.html,style.css}`
- Install: `@playwright/test`

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

The E2E test runs the real server with the OAuth stub swapped in (via a build-time flag or an env var that the real code only honours when `NODE_ENV=test`). Alternative: wire the stub directly in test via a `beforeAll` that monkey-patches the OAuth module — acceptable since it's E2E, not unit.

Flow:
1. Launch server with test env.
2. Navigate to `${APP_ORIGIN}/app`.
3. Stub redirects; complete "login" as `tester@drops.global`.
4. Choose username `tester`.
5. Land on dashboard.
6. Click "New drop", type name `demo`, drag `tests/e2e/fixtures/site` onto the zone.
7. Wait for success redirect.
8. Navigate to `${CONTENT_ORIGIN}/tester/demo/`; assert page text includes "Hello from fixture".
9. Re-upload with a modified fixture; assert the old fixture content is gone.

**Commit:** `test: end-to-end happy path`

---

## Phase 9 — Deployment

### Task 40: Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore`

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY src/views ./src/views
COPY src/db/migrations ./src/db/migrations
EXPOSE 3000
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
```

`.dockerignore`:
```
node_modules
dist
.env
.git
tests
playwright-report
.tmp
```

Local smoke: `docker build -t drops-drops . && docker run --rm --env-file .env -p 3000:3000 drops-drops`.

**Commit:** `chore: Dockerfile`

---

### Task 41: Railway deployment

**Files:**
- Create: `railway.json` (optional; Railway also accepts Nixpacks auto-config)

Using the `railway:new` skill on your end to:
1. Create a Railway project.
2. Add a Postgres plugin.
3. Deploy the service from the repo (Railway reads the Dockerfile).
4. Add the env vars listed in the design (both `APP_ORIGIN` and `CONTENT_ORIGIN`, R2 credentials, etc.).
5. Add custom domains `drops.drops.global` and `content.drops.drops.global` pointing at the service.
6. Seed `allowed_emails` via `railway run psql "$DATABASE_URL" -c "INSERT INTO allowed_emails (email) VALUES ('...')"` for any additional users.

No code change required in this task; it's operational. Document the procedure in `README.md`.

**Commit:** `docs: deployment procedure`

---

## Phase 10 — Nice-to-haves (not started until v1 runs in production)

### Task 43: Basic README

Short README with: what this is, how to run locally, how to test, how to deploy, environment variable list.

---

## Completion criteria

The implementation is "done" when:
1. `pnpm test` is green (all unit + integration tests).
2. `pnpm test:e2e` is green.
3. `pnpm typecheck` is green.
4. `pnpm lint` is green.
5. `docker compose up -d && pnpm dev` boots without error.
6. Production deploy on Railway serves `drops.drops.global` and `content.drops.drops.global` over HTTPS.
7. Manual smoke: log in as `ben@ben-phillips.net`, create a drop by dragging a folder, view it at the content origin, re-upload, verify old content is gone.
