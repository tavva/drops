# drops Drops — Design

**Date:** 2026-04-18
**Status:** Approved for implementation

## Summary

A private static-site host. Authenticated users drag a folder (or a zip) into the browser and get a live URL at `content.drops.drops.global/:username/:dropname/`. Think Netlify Drop, but gated by Google OAuth and confined to a small group.

The app (dashboard, uploads, OAuth) lives on one origin; served drop content lives on a different origin. This separation prevents a malicious drop's JavaScript from reaching into the app under the same origin.

## Goals & Non-Goals

**Goals**
- Google OAuth only, restricted to an allowlist plus anyone on the `drops.global` domain.
- Any authenticated user can view any drop; only the creator can edit or delete their own.
- Drag-drop a folder *or* a zip; serve the result as a static site behind auth.
- Atomic deploys: a re-upload replaces contents cleanly with no broken intermediate state.

**Non-goals (v1)**
- Version history or rollback.
- Custom domains per drop.
- SPA fallback routing, custom 404 pages, or per-drop config.
- An admin UI for the allowlist (seed via SQL).
- Public (unauthenticated) drops.

## Architecture

One Fastify service on Railway, one Postgres instance (Railway add-on), one Cloudflare R2 bucket. The service listens on two hostnames and routes by `Host` header.

```
          app origin                             content origin
    drops.drops.global                content.drops.drops.global
             │                                         │
             ▼                                         ▼
             ┌─────────────────────────────────────┐
             │              Fastify                │
             │  app host:                          │
             │    /auth/*, /app/*, /health         │
             │  content host:                      │
             │    /:username/:dropname/*           │
             └────┬──────────────────┬─────────────┘
                  │                  │
                  ▼                  ▼
           ┌──────────────┐   ┌──────────────┐
           │  Postgres    │   │  R2 bucket   │
           │  (metadata)  │   │  (files)     │
           └──────────────┘   └──────────────┘
```

### Route namespaces

App host (`drops.drops.global`):
- `/auth/*` — OAuth start/callback, choose-username, logout.
- `/app/*` — dashboard, create, upload, delete, edit.
- `/health` — unauthenticated health check (exempt from auth middleware).

Content host (`content.drops.drops.global`):
- `/auth/bootstrap` — sets the content-host session cookie after app-host login.
- `/auth/logout` — clears the content-host session cookie (called as part of the app-host logout chain).
- `/:username/:dropname/*` — serves drop files, auth-gated by the content-host cookie.

A request hitting the wrong host for its path returns 404 (no cross-host route resolution).

### Why two origins

A drop is arbitrary user HTML and JavaScript. If served on the same origin as `/app`, a malicious (or merely careless) drop's JavaScript has same-origin access to `/app` — reading pages, calling APIs with full credentials, defeating every CSRF and session protection we add. Separating origins shuts that path down.

Note: `drops.drops.global` and `content.drops.drops.global` are the *same site* (same registrable domain), so `SameSite=Lax` alone does not prevent a cross-origin credentialed request between them. The real protections, layered:

- **Separate origins → no same-origin DOM access.** Drop JavaScript on the content origin cannot read, navigate, or script into pages on the app origin. No `document.cookie`, no DOM introspection, no access to app-origin `localStorage`.
- **CORS blocks reading responses.** A `fetch()` from the content origin to the app origin will have cookies attached (same-site, host-only), but the browser blocks the drop JavaScript from reading the response body unless we return permissive CORS headers — and we do not.
- **CSRF defences block writes.** All state-changing routes on the app origin require an `Origin`/`Referer` match against `APP_ORIGIN` and a double-submit token bound to the session. A drop-origin `fetch()` fails both checks.
- **Cookie scoping.** Both session cookies are host-only (no `Domain` attribute). `drops_session` goes only to `drops.drops.global`; `drops_content_session` goes only to `content.drops.drops.global`.
- All cookies are `HttpOnly; Secure; SameSite=Lax`.

### Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 access |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth credentials |
| `SESSION_SECRET` | Cookie/CSRF HMAC key |
| `ALLOWED_DOMAIN` | Email domain auto-granted access (`drops.global`) |
| `APP_ORIGIN` | `https://drops.drops.global` |
| `CONTENT_ORIGIN` | `https://content.drops.drops.global` |

The per-email allowlist lives in the database, not in an env var (see schema below).

## Data Model

```sql
-- Allowlist. Seeded with ben@ben-phillips.net.
CREATE TABLE allowed_emails (
  email       TEXT PRIMARY KEY,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users. Row created on first successful login.
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions. Cookie value is the session id.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Pending OAuth logins whose identity is verified but still need a username.
-- Short-lived; expires in 10 minutes. Referenced by a signed cookie.
CREATE TABLE pending_logins (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Drops. One row per (owner, drop name).
CREATE TABLE drops (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  current_version   UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- Drop versions. One row per upload. Immutable. Points at an R2 prefix.
-- Composite unique (id, drop_id) lets drops reference a version *of itself*.
CREATE TABLE drop_versions (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  drop_id     UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  r2_prefix   TEXT NOT NULL,
  byte_size   BIGINT NOT NULL,
  file_count  INT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, drop_id)
);

-- Composite FK: current_version must be a version of *this* drop.
ALTER TABLE drops
  ADD CONSTRAINT fk_current_version_belongs_to_drop
  FOREIGN KEY (current_version, id) REFERENCES drop_versions(id, drop_id);
```

The `drop_versions` table is the mechanism for atomic deploys, not for history. Each upload writes to a fresh prefix; the switch is a single `UPDATE drops SET current_version = ...`; the old prefix is garbage-collected after commit.

We do not store a per-file row. Serving composes the R2 key from `r2_prefix + path` and fetches directly.

### Slug rules (usernames and drop names)

Pattern: `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`.

Reserved usernames: `app`, `auth`, `api`, `static`, `admin`, `_next`, `health`, `favicon.ico`, `robots.txt`.

Drop names are unique per owner, not globally.

## Auth Flow

Standard server-side OIDC authorization-code flow against Google.

1. Unauthenticated request to `/app/*` → 302 to `/auth/login`.
2. `/auth/login`:
   - Generates a random `state` and `nonce`.
   - Stores them in a signed, short-lived `oauth_state` cookie on the app origin (HttpOnly, Secure, SameSite=Lax, 10 min).
   - Redirects to Google's authorization endpoint with `response_type=code`, `scope=openid email profile`, `redirect_uri=${APP_ORIGIN}/auth/callback`, plus `state` and `nonce`.
3. Google redirects back to `/auth/callback?code=...&state=...`:
   - Compare `state` with the value in the signed cookie; reject on mismatch.
   - Exchange `code` for tokens at Google's token endpoint (`grant_type=authorization_code`, with client secret).
   - Verify the returned ID token: signature against Google's JWKS, `iss`, `aud` (= `GOOGLE_CLIENT_ID`), `exp`, and `nonce` matches the one stored.
   - Extract `email`, `email_verified`, `name`, `picture`.
4. Access check:
   - Reject if `email_verified !== true`.
   - Allow if `email` exists in `allowed_emails` or `email` ends with `@${ALLOWED_DOMAIN}`.
   - Otherwise render "not authorised" and create no rows.
5. Resolve identity to a user row:
   - If a row in `users` already matches `email`, go to step 7.
   - Otherwise insert a `pending_logins` row with the verified identity, set a signed `pending_login` cookie (10-minute lifetime) carrying the `pending_logins.id`, and 302 to `/auth/choose-username`.
6. `/auth/choose-username` (app origin):
   - `GET` requires the `pending_login` cookie; reads the pending identity; renders a form with a suggested slug (slugified email local-part, appending `-2`, `-3`, ... if taken).
   - `POST` validates the slug against the rules and reserved list, then in one transaction: inserts the `users` row, deletes the `pending_logins` row, and continues to step 7. On slug collision it re-renders the form with an error.
7. Create a `sessions` row for the user. Set the app-origin session cookie (`drops_session`). Then 302 to the content-origin bootstrap endpoint carrying a short-lived signed handoff token: `${CONTENT_ORIGIN}/auth/bootstrap?token=...&next=${target}`. `target` is the validated `next` parameter that was stashed alongside `state`/`nonce` in the `oauth_state` cookie at step 2 (origin must be `APP_ORIGIN` or `CONTENT_ORIGIN`); if no valid target was carried through login, `target = ${APP_ORIGIN}/app`.
8. Content-origin `/auth/bootstrap`:
   - Verify the HMAC signature and expiry (60 seconds) of the handoff token. Its payload is the session id.
   - Set the content-origin cookie (`drops_content_session`) with the same session id.
   - 302 to `next`. `next` is validated against an explicit allowlist: its origin must be exactly `APP_ORIGIN` or `CONTENT_ORIGIN`. Any other value falls back to `${APP_ORIGIN}/app`.

**Cookies**

| Cookie | Origin | Purpose |
|---|---|---|
| `drops_session` | `drops.drops.global` | App-host session |
| `drops_content_session` | `content.drops.drops.global` | Content-host session (same session id) |
| `oauth_state` | app origin | Signed CSRF state + nonce during OAuth dance (short-lived) |
| `pending_login` | app origin | Signed reference to a verified-but-unassigned identity (short-lived) |

All cookies: `HttpOnly; Secure; SameSite=Lax; Path=/`. Session cookies: `Max-Age=30 days`, rolling (`sessions.expires_at` extends when more than 24 hours old on any request). No `Domain` attribute on any cookie — each is host-only.

**Auth middleware**

- App host: exempted routes are `/health`, `/auth/login`, `/auth/callback`, `/auth/choose-username` (requires the `pending_login` cookie instead), and static assets under `/app/static/*`. All other routes require a valid `drops_session`.
- Content host: exempted routes are `/auth/bootstrap` and `/auth/logout`. All other routes require a valid `drops_content_session`.

On miss or expiry:
- App host → 302 to `/auth/login`.
- Content host → 302 to `${APP_ORIGIN}/auth/login?next=${originalUrl}`; after login, the app-origin completion step issues a bootstrap handoff whose `next` returns the user to `originalUrl`.

`POST /auth/logout` (app origin) deletes the `sessions` row, clears `drops_session`, and also redirects through `${CONTENT_ORIGIN}/auth/logout` which clears `drops_content_session`.

## Upload Flow (Atomic Replace)

### Endpoints

There is a single upload endpoint for both creating and updating a drop:

- `POST /app/drops/:name/upload?upload_type=folder|zip`

If `:name` does not exist for the current user, the endpoint creates the drop as part of the same request. If it exists, the endpoint requires the current user to own it. `upload_type` is a query parameter (not a form field) so the server can choose per-request multipart limits before parsing the body.

The body is `multipart/form-data` containing the uploaded files.

The separate `GET /app/drops/new` page is a UI-only form — it collects the desired drop name plus the file/folder/zip and POSTs directly to `/app/drops/:name/upload?upload_type=…`. No empty drop row is ever created upfront.

### Client — folder

1. User drags a folder onto the drop page.
2. The browser walks `DataTransferItemList` via `webkitGetAsEntry`, producing a flat list of `{relativePath, File}`.
3. Client-side pre-checks (UX only, not a security boundary): total ≤ 100 MB, file count ≤ 1000, each file ≤ 25 MB, skip `.DS_Store` and `.git/*`.
4. POSTs a single `multipart/form-data` request containing every file. The server re-validates everything.

### Client — zip

1. User drops a single `.zip` file (or picks one via a file input).
2. Client POSTs it as a single `application/zip` part with `upload_type=zip`.

### Server

1. Auth check. Validate `:name` against slug rules and reserved list.
2. Determine intent and ownership under a `SELECT ... FOR UPDATE` (or advisory lock keyed on `(user_id, name)`):
   - If `drops` row exists with `owner_id = current user`, this is an update.
   - If `drops` row exists with a different owner, return 403.
   - If no row exists, this is a create. **Do not insert the `drops` row yet** — defer until after R2 success (step 7).
3. Allocate `version_id = uuid()`. Compute `r2_prefix = drops/<version_id>/`. Version ids are globally unique; the prefix is keyed on the version alone so the R2 write can start before the `drops.id` is known (useful for the concurrent-create race — see Serving / Concurrency).
4. **Server-side path sanitisation (applies to both folder and zip paths):**
   - Decode, normalise (`NFC`), strip any leading `/`, collapse `./`, reject any `..` segment.
   - Reject absolute Windows paths (drive letters, leading `\`).
   - Reject components whose name is `.` or `..` or empty.
   - Reject control characters and NUL bytes.
   - For zip, also reject entries whose Unix mode (from `externalFileAttributes`) is a symlink.
   - Reject server-side dotfiles: any path component starting with `.`.
   - If two different sanitised paths collide after normalisation, reject the upload (`400 conflicting paths after canonicalisation`).
5. Folder path: stream each multipart part to R2 at `${r2_prefix}${sanitisedPath}`, setting `Content-Type` from the extension, tracking `byte_size` and `file_count`, and enforcing per-file and total limits against bytes actually read.
6. Zip path: stream-unzip with `yauzl` entry-by-entry. For each entry:
   - Skip directories.
   - Apply the same sanitisation (step 4).
   - Enforce the per-file and total size limits against *decompressed* bytes.
   - Zip-bomb guard: abort if a single entry expands more than 100× its compressed size *and* exceeds 10 MB decompressed.
   - Single-root unwrap: before upload, scan sanitised entries. If all share a common top-level directory (e.g. `my-site/...`), strip that prefix. Matches how `zip -r my-site.zip my-site/` works by convention.
   - Stream the entry to R2 at `${r2_prefix}${cleanedPath}`.
7. If any write fails at any point, delete every object written so far under `r2_prefix` and return an error. No DB rows are touched. An existing drop continues to serve the old version; a failed first upload leaves no drop row behind.
8. On success, in a single transaction (last-commit-wins model, no locks held across the upload):
   - `INSERT INTO drops (owner_id, name) VALUES (user.id, name) ON CONFLICT (owner_id, name) DO NOTHING` followed by a `SELECT id, current_version FROM drops WHERE owner_id = user.id AND name = name`. The resulting `drop_id` is either our new row's or the one another concurrent upload won the race to create.
   - `SELECT id, current_version FROM drops WHERE id = drop_id FOR UPDATE` — serialises concurrent version swaps on the same drop and captures `old_version_id`.
   - Insert the `drop_versions` row keyed on `drop_id`.
   - `UPDATE drops SET current_version = version_id, updated_at = now() WHERE id = drop_id`.
9. Post-commit, if `old_version_id IS NOT NULL`, enqueue garbage collection: list R2 objects under the old prefix, delete them, then delete the old `drop_versions` row. A nightly sweep retries any version row not referenced as a `current_version` on any drop.

### Limits

- Total ≤ 100 MB (compressed or decompressed).
- File count ≤ 1000.
- Each file ≤ 25 MB.

## Serving Drops

Route: `GET /:username/:dropname/*` on the **content host** (`content.drops.drops.global`). Requests to this path pattern on the app host return 404.

1. Content-host auth middleware runs first: requires a valid `drops_content_session`. Any authenticated user may view any drop. No-session handling is covered in the Auth Flow section (bootstrap redirect through the app host).
2. Look up the user by `username`, then the drop by `(owner_id, name)`, then the `current_version` and its `r2_prefix`. Any miss is a 404.
3. Resolve the path:
   - `GET /:username/:dropname` → 301 to `/:username/:dropname/` (so relative paths in HTML resolve).
   - Empty remainder or trailing `/` → append `index.html`.
   - Try `${r2_prefix}${rest}` via R2 `GetObject`.
   - On 404, if `rest` does not already end in `.html` or `/`, try `${rest}/index.html` (directory index).
   - Still 404 → plain-text `404 Not Found`.
4. Stream the R2 body to the client.
   - `Content-Type` from R2 metadata (set at upload from file extension).
   - `Content-Length` passthrough.
   - `Cache-Control: private, max-age=0, must-revalidate`.
   - `ETag` passthrough; honour `If-None-Match` with a 304.
5. Reject any `rest` containing `..` or a leading `/` after splitting.

MIME map (small static lookup): html, css, js, json, svg, png, jpg, jpeg, gif, webp, ico, woff2, txt, xml, pdf, mp4, wasm. Unknown → `application/octet-stream`.

Support `HEAD` with the same resolution logic and no body.

## App UI

Server-rendered HTML with a sprinkle of vanilla JavaScript for drag-drop. Single stylesheet; no framework required.

**`GET /app`** — dashboard with two lists:
- *Your drops*: owned by the current user, newest first. Each row: name, `updated_at`, size, links to view / edit / delete.
- *All drops*: everyone's drops, newest first, paginated (25 per page).

**`GET /app/drops/new`** — create form with a drop-name input and a drag-drop zone. Submits directly to `POST /app/drops/:name/upload`, which atomically creates the drop row only if the upload succeeds. A failed first upload leaves no drop row behind.

**`GET /app/drops/:name`** (owner only) — edit page. Shows current version metadata, a "View" link to `${CONTENT_ORIGIN}/:username/:name/`, and a "Replace contents" drag-drop zone. A "Delete drop" button (with confirm) triggers `DELETE /app/drops/:name`, which removes the drop, version rows, and R2 prefix.

Non-owners hitting `/app/drops/:name` receive 403. They can still view the drop at the content origin.

Nav: "Drops" on the left, username plus logout on the right.

## Testing

- **Unit**: slug validation, allowlist check, path resolution, MIME lookup. Pure functions.
- **Integration** (real Postgres plus a local S3 implementation such as MinIO or LocalStack):
  - OAuth callback with allowed and disallowed emails.
  - Full upload → serve → re-upload → old assets gone → new assets served.
  - Path-traversal attempts return 404.
  - Trailing-slash redirect.
  - Concurrent uploads to the same drop; the later commit wins cleanly.
  - Zip path: single-root unwrap, zip-bomb guard, corrupt archive handling.
- **E2E**: one Playwright happy path against a running instance with a stubbed Google OAuth endpoint — drag a folder, upload, view, re-upload, verify old contents gone.

No mocking of R2 or Postgres in integration tests.

## Errors and Operations

- Upload failure mid-flight → delete the in-progress R2 prefix, return 500 with a human-readable message; the drop stays on the old version.
- Google OAuth failure → render a login-failed page with a "try again" link.
- R2 read failure while serving → 502, logged with the request id.
- Structured JSON logs via Pino. Every line carries `request_id` (nanoid) and, when authenticated, `user_id`.
- `GET /health` → 200 with `{db: "ok", r2: "ok"}` after pinging each.
- Orphan GC: hourly interval sweeps `drop_versions` rows not referenced as any drop's `current_version`, deleting R2 prefixes then DB rows.

## Security

- **Origin separation.** App (`drops.drops.global`) and content (`content.drops.drops.global`) are independent origins with independent cookies, so drop JavaScript has no same-origin access to `/app`.
- **CSRF.** All state-changing routes require a same-origin `Origin`/`Referer` check against `APP_ORIGIN` and a double-submit token bound to the session.
- **CSP on the app origin.** Strict `Content-Security-Policy` with nonce-based script allowance; no `unsafe-inline`. No CSP on served drops — their contents are user-controlled.
- **Frame protection.** `X-Frame-Options: DENY` on the app origin. The content origin allows framing (drops may embed or be embedded); the origin separation makes this safe.
- **Rate limiting.** `/auth/*` and upload endpoints via `@fastify/rate-limit`.
- **Path safety.** R2 keys strictly under the drop's prefix; server-side sanitisation rejects `..`, absolute paths, symlinks, control characters, and post-canonicalisation collisions.
- **Transport.** `Strict-Transport-Security: max-age=63072000; includeSubDomains` on both origins.

## Stack Summary

- Runtime: Node 22, TypeScript.
- HTTP: Fastify.
- DB: Postgres via Drizzle or Kysely (either works; pick one during implementation).
- Object store: Cloudflare R2 via `@aws-sdk/client-s3`.
- Zip: `yauzl` (streaming).
- Templates: `@fastify/view` with EJS, or template literals.
- Logging: Pino.
- Testing: Vitest plus Playwright for E2E.
- Host: Railway (one service, one Postgres add-on, Cloudflare R2 external).

## Open Questions

None at approval time. Items to revisit once v1 is live:

- Version history and rollback (upgrade path is additive: stop GC, add a `versions` UI).
- Admin UI for the `allowed_emails` table.
- SPA fallback per-drop toggle.
- Custom 404 pages per drop.
