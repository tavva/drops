# Per-drop content origins — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Serve every drop on its own origin (`<user>--<dropname>.<content-root-domain>`) so hostile HTML in one drop cannot use same-origin `fetch` to exfiltrate sibling drops.

**Architecture:**

- The content host today is a single apex (`content.drops.humanf.actor`) serving every drop under `/<user>/<drop>/*`. Same origin for every drop + a shared session cookie + no CSP on uploaded HTML = any drop's JavaScript can read any sibling the victim is authorised for.
- The fix: one subdomain per drop, one cookie per subdomain. Browsers' same-origin policy enforces isolation; the Domain cookie attribute plus a host-bound signed payload enforces it server-side as defence-in-depth.
- The apex becomes a redirect surface: `/<user>/<drop>/…` 301s to the subdomain.
- Flow on first visit to a drop: drop host has no cookie → bounces to app's `/auth/drop-bootstrap?host=…&next=…` → (if app session exists) app mints handoff bound to `(sid, drophost)` → browser lands on `<drophost>/auth/bootstrap?token=…` → drop host sets its own Domain-scoped cookie → redirects to drop path. Subsequent visits use the cookie directly.

**Tech stack:** Fastify 5, `@fastify/cookie`, `@fastify/helmet`, Node crypto HMAC-SHA256, Drizzle, vitest.

**Prerequisites before prod cutover (Phase 7):**
- Wildcard `CNAME *.content.drops.humanf.actor → <railway-target>` at Gandi.
- Railway custom domain `*.content.drops.humanf.actor` added to the service (TLS handled by Railway via LE DNS-01 once DNS resolves).

---

## Conventions

- Every `.ts` file starts with two `// ABOUTME: ` lines — preserve on edit.
- ESM, `@/*` alias for `src/*`, British English in user-facing copy.
- Run tests after each task: `pnpm test -- <file>`. Integration tests need `docker compose up -d`.
- Commit after every task that leaves tests green.
- Drop host parse regex is authoritative: `^([a-z0-9][a-z0-9-]{0,30}[a-z0-9])--([a-z0-9][a-z0-9-]{0,30}[a-z0-9])\.<root>$`. Slugs already ban `--`, so parse is unambiguous.
- All new HMAC payloads use `|` as a field separator (sessionIds are base64url, no `|`).

---

## Phase 1 — Foundations (no behaviour change)

### Task 1: Drop-host helpers + unit tests

**Files:**
- Create: `src/lib/dropHost.ts`
- Create: `tests/unit/dropHost.test.ts`

**Code outline** (`src/lib/dropHost.ts`):

```ts
// ABOUTME: Parse and build per-drop subdomain hostnames under the content root domain.
// ABOUTME: Drop host = `<username>--<dropname>.<contentRootDomain>`; parser returns null on mismatch.
import { config } from '@/config';

export function contentRootDomain(): string {
  return new URL(config.CONTENT_ORIGIN).hostname.toLowerCase();
}

export function dropHostFor(username: string, dropname: string, root = contentRootDomain()): string {
  return `${username}--${dropname}.${root}`;
}

export function dropOriginFor(username: string, dropname: string): string {
  const u = new URL(config.CONTENT_ORIGIN);
  u.hostname = dropHostFor(username, dropname, u.hostname.toLowerCase());
  return u.origin;
}

export interface ParsedDropHost { username: string; dropname: string; }
const SEG = '[a-z0-9][a-z0-9-]{0,30}[a-z0-9]';
const PARSE_RE = new RegExp(`^(${SEG})--(${SEG})$`);

export function parseDropHost(hostHeader: string | undefined): ParsedDropHost | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0]!.toLowerCase();
  const root = contentRootDomain();
  if (host === root) return null;
  if (!host.endsWith('.' + root)) return null;
  const sub = host.slice(0, host.length - root.length - 1);
  const m = PARSE_RE.exec(sub);
  if (!m) return null;
  return { username: m[1]!, dropname: m[2]! };
}
```

**Unit tests cover:** valid parse, rejects bare apex, rejects unrelated domain, rejects `a--b--c` (only two `--` slugs), rejects uppercase, rejects leading/trailing hyphen, ignores port in header, round-trips `dropHostFor` → `parseDropHost`.

**TDD:** write the tests first, watch them fail, implement, green, commit (`feat(drops): add drop-host helpers`).

### Task 2: Extend host detection

**Files:**
- Modify: `src/server.ts:44-53` (`onRequest` hook + `HostKind`)
- Modify: `src/middleware/host.ts` (add `onDropHost`)
- Create: `tests/integration/drop-host-detection.test.ts`

**Change:** `HostKind` becomes `'app' | 'content' | 'drop' | 'unknown'`. Add `req.dropHost?: { username: string; dropname: string; hostname: string }`. Detection order: app → content apex → drop-host parse → unknown.

```ts
// server.ts
import { parseDropHost, contentRootDomain } from '@/lib/dropHost';

declare module 'fastify' {
  interface FastifyRequest {
    hostKind: HostKind;
    dropHost?: { username: string; dropname: string; hostname: string };
  }
}

app.decorateRequest('hostKind', 'unknown');
app.decorateRequest('dropHost', undefined);
app.addHook('onRequest', async (req) => {
  const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
  const appHost = new URL(config.APP_ORIGIN).hostname.toLowerCase();
  const contentApex = contentRootDomain();
  if (host === appHost) { req.hostKind = 'app'; return; }
  if (host === contentApex) { req.hostKind = 'content'; return; }
  const parsed = parseDropHost(host);
  if (parsed) {
    req.hostKind = 'drop';
    req.dropHost = { ...parsed, hostname: host };
    return;
  }
  req.hostKind = 'unknown';
});
```

```ts
// middleware/host.ts — add:
export function onDropHost(plugin: FastifyPluginAsync): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', async (req, reply) => {
      if (req.hostKind !== 'drop') reply.callNotFound();
    });
    await app.register(plugin);
  };
}
```

**Tests:** `alice--foo.content.localtest.me` → `hostKind='drop'`, parsed; `content.localtest.me` → `'content'`; `drops.localtest.me` → `'app'`; `evil.com` → `'unknown'`; `onDropHost`-scoped plugin 404s for non-drop hosts.

Commit: `feat(host): detect drop-subdomain hosts`.

---

## Phase 2 — Host-bound crypto

### Task 3: Host-bound handoff token

**Files:**
- Modify: `src/lib/handoff.ts` (breaking signature change)
- Modify: `tests/unit/handoff.test.ts`
- Modify: every caller of `signHandoff` / `verifyHandoff`
- Modify: every caller of bootstrap-producing redirects to thread the drop host through

**New signatures:**

```ts
export function signHandoff(sessionId: string, host: string, key: string, ttlSeconds: number): string;
export function verifyHandoff(token: string, expectedHost: string, key: string): HandoffResult;
// payload: base64url(`${sessionId}|${host}|${exp}`) + '.' + sig
```

**Tests:** round-trip with correct host passes; wrong host returns `invalid`; expired fails; tampered fails.

**Callers to update (compile-time failures will enumerate these):**
- `src/routes/auth/callback.ts` — pass the target drop host when minting.
- `src/routes/auth/chooseUsername.ts` — same.
- `src/routes/auth/bootstrap.ts` — pass current drop host when verifying.

For this task, keep callers compiling by passing `contentRootDomain()` as the host — in Phase 3 we wire the real drop host through. The change is just the signature.

Commit: `feat(handoff): bind token to target host`.

### Task 4: Drop session cookie with host binding

**Files:**
- Modify: `src/lib/cookies.ts` — add `signDropCookie(sid, host, key)`, `verifyDropCookie(raw, host, key)`, `dropCookieOptions(host)`.
- Modify: `tests/unit/cookies.test.ts` — cover host-binding round-trip, reject wrong host.

```ts
// cookies.ts — add alongside existing signCookie/verifyCookie
export function signDropCookie(sessionId: string, host: string, key: string): string {
  const payload = `${sessionId}|${host}`;
  return `${payload}.${mac(payload, key)}`;
}

export function verifyDropCookie(raw: string, expectedHost: string, key: string): string | null {
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = mac(payload, key);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [sid, host] = payload.split('|');
  if (!sid || !host || host !== expectedHost) return null;
  return sid;
}

export function dropCookieOptions(host: string, overrides: Partial<CookieOptions> = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureOrigin(config.CONTENT_ORIGIN),
    sameSite: 'lax',
    path: '/',
    // @fastify/cookie serializes this; browsers scope the cookie to exactly this host
    domain: host,
    ...overrides,
  };
}
```

Note: existing `CookieOptions` type has `domain?: undefined`. Widen it to `domain?: string`. Update callers that previously relied on the narrow type to pass no `domain`.

Commit: `feat(cookies): host-scoped signed drop cookie`.

---

## Phase 3 — Drop-bootstrap flow

### Task 5: App-host `/auth/drop-bootstrap`

**Files:**
- Create: `src/routes/auth/dropBootstrap.ts`
- Register: `src/index.ts` (under `onAppHost`)
- Create: `tests/integration/auth-drop-bootstrap.test.ts`

**Behaviour:**
- Method `GET`. Query params: `host` (required, must match a valid drop host under the content root), `next` (path on that drop host; defaults to `/`).
- Require an app-host session (`requireAppSession`). If none, redirect to `/auth/login?next=<self-url-with-same-query>`.
- Validate `host`: `parseDropHost(host)` must return a valid parse. Lookup `(user, drop)` via `findByUsername` + `findByOwnerAndName` — 404 if either missing.
- Run `canView({ id: req.user!.id, email: req.user!.email }, drop)`. If false, redirect to `/app` (no enumeration — just drop them home).
- Mint `signHandoff(sid, host, SESSION_SECRET, 60)`.
- Redirect 302 to `https://<host>/auth/bootstrap?token=<url-encoded>&next=<url-encoded-path>` (use CONTENT_ORIGIN's protocol and port).

**Tests:**
- No app session → redirected to `/auth/login` with `next` preserving host+next.
- Valid session + valid drop + canView true → 302 to drop host bootstrap.
- Valid session + canView false → 302 to `/app`.
- Invalid host (not parseable / unknown user or drop) → 404.

Commit: `feat(auth): add drop-bootstrap route`.

### Task 6: Drop-host `/auth/bootstrap`

**Files:**
- Rewrite: `src/routes/auth/bootstrap.ts` (was on content apex; move to drop host)
- Update: `src/index.ts` — register under `onDropHost`, remove from `onContentHost`.
- Rewrite: `tests/integration/auth-bootstrap.test.ts`

**Behaviour:**
- `GET /auth/bootstrap?token=…&next=…` on a drop subdomain.
- Parse current drop host from `req.dropHost`. If missing, 404.
- `verifyHandoff(token, req.dropHost.hostname, SESSION_SECRET)` — reject with 400 on failure.
- Fetch session (`getSessionUser`) — reject if missing.
- Re-check `canView(user, drop)` — reject with 403 if false (defence-in-depth; the app-side check could be stale).
- Set cookie: name `drops_drop_session`, value `signDropCookie(sid, host, SECRET)`, options `dropCookieOptions(host, { maxAge: 30 * 24 * 3600 })`.
- Validate `next`: must be a path beginning with `/` or a full URL whose host matches the current drop host; else default `/`.
- Redirect 302 to `next`.

**Tests:**
- Valid token + canView + allowed next path → 302, cookie set with `Domain=<drophost>`.
- Token for wrong host → 400.
- Expired token → 400.
- canView false → 403.
- `next=http://evil.com` or a cross-drop host → clamped to `/`.

Commit: `feat(auth): drop-host bootstrap sets host-scoped cookie`.

### Task 7: `requireDropSession`

**Files:**
- Modify: `src/middleware/auth.ts` — add `requireDropSession`.
- Update: `tests/integration/auth-middleware.test.ts` or new file.

**Behaviour:**
```ts
export const DROP_SESSION_COOKIE = 'drops_drop_session';

export async function requireDropSession(req: FastifyRequest, reply: FastifyReply) {
  const parsed = req.dropHost;
  if (!parsed) { reply.callNotFound(); return; }
  const raw = req.cookies[DROP_SESSION_COOKIE];
  const sid = raw ? verifyDropCookie(raw, parsed.hostname, config.SESSION_SECRET) : null;
  if (!sid) return bounceToBootstrap(reply, parsed.hostname, req.raw.url ?? '/');
  const found = await getSessionUser(sid);
  if (!found) {
    reply.clearCookie(DROP_SESSION_COOKIE, dropCookieOptions(parsed.hostname));
    return bounceToBootstrap(reply, parsed.hostname, req.raw.url ?? '/');
  }
  await rollIfStale(sid);
  req.session = { id: sid };
  req.user = { id: found.user.id, email: found.user.email, username: found.user.username, name: found.user.name, avatarUrl: found.user.avatarUrl, kind: found.user.kind as 'member' | 'viewer' };
}

function bounceToBootstrap(reply: FastifyReply, host: string, path: string): FastifyReply {
  const target = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
  target.searchParams.set('host', host);
  target.searchParams.set('next', path);
  return reply.redirect(target.toString(), 302);
}
```

**Tests:** missing cookie → 302 to `/auth/drop-bootstrap`; valid cookie → user set; wrong-host-bound cookie rejected.

Commit: `feat(auth): requireDropSession middleware`.

---

## Phase 4 — Drop-host serving

### Task 8: Drop-host security headers

**Files:**
- Modify: `src/middleware/security.ts` — add `registerDropSecurity` (identical to `registerContentSecurity`).
- Content apex security stays as-is but apex now serves redirects only.

Commit: `feat(security): add drop-host helmet config`.

### Task 9: Drop-host content serve route

**Files:**
- Create: `src/routes/content/dropServe.ts` (new) OR rewrite `src/routes/content/serve.ts` and rename.
- Update: `src/index.ts` — register under `onDropHost`.
- Rewrite: `tests/integration/content-serve.test.ts`.

**Behaviour:**
- Routes: `GET|HEAD /*` (splat only — no `/:user/:drop` in path now).
- `requireDropSession` as preHandler.
- Drop identity from `req.dropHost`: look up user by username, drop by `findByOwnerAndName`. 404 if either missing.
- `canView(user, drop)` — 404 if false.
- Same splat-to-object logic as today: `index.html` fallback, single-file drop fallback, ETag/304.

**Tests:** adapt existing `content-serve.test.ts` — all `inject` calls use `host: 'alice--foo.content.localtest.me'` and paths become `/`, `/about.html`, etc.

Commit: `feat(content): serve drops from per-drop subdomain`.

### Task 10: Apex legacy redirect

**Files:**
- Modify: `src/routes/content/serve.ts` OR new `src/routes/content/legacyRedirect.ts`
- Register under `onContentHost`.
- Tests: new `tests/integration/content-apex-redirect.test.ts`.

**Behaviour:**
- `GET /:username/:dropname` and `GET /:username/:dropname/*` on the **apex** (hostKind='content') → 301 to `https://<user>--<drop>.<root>/<splat>`.
- No auth required (it's just a redirect).
- Validate both slugs before constructing the redirect; otherwise 404.

Commit: `feat(content): redirect legacy apex URLs to drop subdomain`.

### Task 11: App-side URL generation

**Files:**
- Modify: `src/views/dashboard.ejs` — "open drop" links use `dropOriginFor`.
- Modify: `src/views/editDrop.ejs` — `contentUrl` constructed via `dropOriginFor`.
- Modify: `src/views/chooseUsername.ejs:33` — the host preview should still show the content root (since the user's drops will all live under `<user>--…`, the root is the relevant prefix in that copy). Leave text as `new URL(contentOrigin).host` pointing at the root; update copy if needed.
- Modify: `src/routes/app/upload.ts:123-124` — redirect target to drop subdomain (`dropOriginFor(user.username, name) + '/'`).
- Modify: `src/routes/app/dashboard.ts` / `editDrop.ts` — pass a helper or inline `dropOriginFor` into template locals.
- Create: small view helper `src/views/helpers.ts` exporting `dropOriginFor` for templates (or pass it in each `reply.view` call).

**Tests:** update `tests/integration/dashboard.test.ts`, `edit-delete.test.ts`, `upload-endpoint.test.ts` to assert the new URLs.

Commit: `feat(views): generate drop-subdomain URLs`.

### Task 12: Remove content apex session + root page

**Files:**
- Delete: `src/views/contentRoot.ejs`.
- Delete: `src/routes/auth/contentLogout.ts`.
- Modify: `src/routes/app/root.ts` — `/` on content apex now returns 404 (or redirects to app origin dashboard, your call — 404 is simpler and correct).
- Modify: `src/index.ts` — unregister `contentLogoutRoute`.
- Modify: `src/middleware/auth.ts` — delete `CONTENT_SESSION_COOKIE` export + `requireContentSession`.
- Modify: `src/routes/auth/logout.ts` — drop the cross-origin hop. `POST /auth/logout` now: delete session row, clear app cookie, redirect to `/auth/goodbye`. Drop-host cookies orphan on their own (next request finds no session in DB → bounces through drop-bootstrap which requires app session which is gone → land on login).
- Update/remove: `tests/integration/content-root.test.ts`, `auth-logout.test.ts`.

Commit: `refactor(content): remove apex session + cross-origin logout hop`.

---

## Phase 5 — Login integration

### Task 13: Callback sends drop-host handoffs when `next` is a drop URL

**Files:**
- Modify: `src/routes/auth/callback.ts`.
- Modify: `src/routes/auth/chooseUsername.ts`.
- Modify: `tests/integration/auth-callback.test.ts`, `choose-username.test.ts`.

**Change:**
- `issueSessionAndHandoff` currently always redirects to `/auth/bootstrap` on the content apex. Replace with logic that examines `nextUrl`:
  - If `nextUrl` parses to a drop host → mint `signHandoff(sid, dropHost, key, 60)`, redirect to `https://<dropHost>/auth/bootstrap?token=…&next=<path>`.
  - Otherwise → redirect straight to `nextUrl` (app host) without a bootstrap hop (there's no content apex cookie any more).

**Tests:** callback with `next=http://alice--foo.content.localtest.me:3000/` → 302 to that host's bootstrap with host-bound token; callback with `next=/app` → 302 to `/app` directly.

Commit: `feat(auth): callback routes drop-host handoffs`.

### Task 14: Login short-circuit for already-authed users

**Files:**
- Modify: `src/routes/auth/login.ts`.
- Tests: `tests/integration/auth-login.test.ts`.

**Behaviour:** if the request already has a valid app session, and `next` parses to a drop host, skip OAuth and redirect straight to the same flow as `/auth/drop-bootstrap` — mint the handoff and bounce to the drop host.

If no session, proceed with the existing OAuth flow.

Commit: `feat(auth): login short-circuit when already authed`.

---

## Phase 6 — Hardening + docs

### Task 15: Apply tight rate limits to auth paths

**Files:**
- Modify: `src/routes/auth/login.ts`, `callback.ts`, `bootstrap.ts` (drop host), `dropBootstrap.ts`, `chooseUsername.ts`, `upload.ts`.
- Use existing `tightAuthLimit` / `uploadLimit` from `src/middleware/rateLimit.ts` — attach via `config: { rateLimit: { … } }` on each route definition.
- Tests: new `tests/integration/rate-limit.test.ts` cases (or extend existing) for the auth surface.

Commit: `feat(rate-limit): apply tight limits to auth + upload`.

### Task 16: `allowedNext` recognises drop hosts

**Files:**
- Modify: `src/routes/auth/login.ts` — `allowedNext` allows: `APP_ORIGIN`, `CONTENT_ORIGIN` (apex, for legacy URLs that will be redirected), and any parseable drop host under the content root.
- Modify: `tests/integration/auth-login.test.ts`.

Commit: `feat(auth): allowedNext covers drop hosts`.

### Task 17: README + CLAUDE.md architecture update

**Files:**
- Modify: `README.md` — update the ASCII diagram, "How it works", and add a new deploy-step for wildcard DNS + Railway wildcard domain.
- Modify: `CLAUDE.md` — update the "Two origins" paragraph to describe the three-tier host model (app, content apex for redirects, drop subdomains for serving); note `parseDropHost` / `dropHostFor` / `requireDropSession` as the load-bearing abstractions.

Commit: `docs: document per-drop origin model`.

---

## Phase 7 — Deploy checklist (not a code task)

1. Gandi: add DNS record `CNAME *.content.drops.humanf.actor → <railway-cname-target>` (reuse whatever the apex content record points at; Railway uses the same target for wildcards).
2. Railway: add `*.content.drops.humanf.actor` as a custom domain on the `drops` service. Wait for TLS to provision (Railway → Settings → Networking shows green tick).
3. Verify: `dig +short any.content.drops.humanf.actor` resolves; `curl -I https://wildcard-test.content.drops.humanf.actor` returns a Railway 404 (no drop matches; expected).
4. Deploy the branch. First request to any drop triggers the bootstrap hop; subsequent requests are cookie-served.
5. Monitor `/health` and logs for a day. The legacy `/<user>/<drop>/` URLs continue to work via the 301.

---

## Verification (before merging)

Run all tests + typecheck + lint. Manual smoke:
- Log in from scratch → land on `/app`.
- Click open on a private drop → bootstrap hop → drop loads.
- Inside that drop's HTML, `fetch('/other-path')` works (same origin). `fetch('https://bob--thing.<root>/')` should be blocked by SOP (no cookie sent, 302-to-bootstrap redirect body opaque to the script).
- Second visit to the same drop does not bootstrap (cookie present).
- Logout on app → app cookie cleared; visiting any drop bounces to login.
- Legacy URL `/<user>/<drop>/` on apex → 301 to subdomain.

---

## Notes / open questions

- Cookie `maxAge`: 30 days per drop. Each visited drop accumulates its own cookie. Acceptable for now; revisit if someone accumulates hundreds.
- `req.raw.url` in `requireDropSession` preserves query string for the bootstrap `next`. Paths with fragments aren't an issue server-side (fragments never reach the server).
- `setUserKind` downgrade on login still happens on the app side only — drop cookies keep working until natural expiry, but `canView` re-runs per request, so access is correctly gated either way.
- The apex `content.drops.humanf.actor` has no remaining user-content surface, only 301 redirects. Helmet config stays strict there.
