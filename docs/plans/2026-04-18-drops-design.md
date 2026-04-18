# drops Drops — Design

**Date:** 2026-04-18
**Status:** Approved for implementation

## Summary

A private static-site host. Authenticated users drag a folder (or a zip) into the browser and get a live URL at `drops.drops.global/:username/:dropname/`. Think Netlify Drop, but gated by Google OAuth and confined to a small group.

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

One Fastify service on Railway, one Postgres instance (Railway add-on), one Cloudflare R2 bucket.

```
             ┌─────────────────────────────────────┐
             │  drops.drops.global  (Railway)  │
             │  ┌──────────────────────────────┐   │
  browser ──►│  │   Fastify + TypeScript       │   │
             │  │   - auth middleware          │   │
             │  │   - OAuth routes             │   │
             │  │   - upload handler           │   │
             │  │   - file-serving handler     │   │
             │  └──────────────────────────────┘   │
             └────┬──────────────────┬─────────────┘
                  │                  │
                  ▼                  ▼
           ┌──────────────┐   ┌──────────────┐
           │  Postgres    │   │  R2 bucket   │
           │  (metadata)  │   │  (files)     │
           └──────────────┘   └──────────────┘
```

Route namespaces (order matters — `/app` and `/auth` win over the catch-all):

- `/auth/*` — OAuth callback, logout, choose-username.
- `/app/*` — dashboard, drop list, create, upload, delete.
- `/:username/:dropname/*` — serves drop files, auth-gated.

### Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 access |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth credentials |
| `SESSION_SECRET` | Cookie/CSRF HMAC key |
| `ALLOWED_DOMAIN` | Email domain auto-granted access (`drops.global`) |
| `BASE_URL` | Canonical origin (`https://drops.drops.global`) |

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
CREATE TABLE drop_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id     UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  r2_prefix   TEXT NOT NULL,
  byte_size   BIGINT NOT NULL,
  file_count  INT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE drops
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version) REFERENCES drop_versions(id);
```

The `drop_versions` table is the mechanism for atomic deploys, not for history. Each upload writes to a fresh prefix; the switch is a single `UPDATE drops SET current_version = ...`; the old prefix is garbage-collected after commit.

We do not store a per-file row. Serving composes the R2 key from `r2_prefix + path` and fetches directly.

### Slug rules (usernames and drop names)

Pattern: `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`.

Reserved usernames: `app`, `auth`, `api`, `static`, `admin`, `_next`, `health`, `favicon.ico`, `robots.txt`.

Drop names are unique per owner, not globally.

## Auth Flow

1. Unauthenticated request to `/app/*` → redirect to `/auth/login`.
2. `/auth/login` redirects to Google OAuth with scopes `openid email profile` and a signed `state` cookie for CSRF.
3. Google redirects to `/auth/callback`. The server verifies the ID token (signature, `aud`, `iss`, `exp`) and extracts `email`, `email_verified`, `name`, `picture`.
4. Access check:
   - Reject if `email_verified !== true`.
   - Allow if `email` exists in `allowed_emails` or `email` ends with `@${ALLOWED_DOMAIN}`.
   - Otherwise render a "not authorised" page and create no user row.
5. On first login, prompt for a username at `/auth/choose-username`. Pre-fill with the slugified email local-part, appending `-2`, `-3`, ... if taken. Validate against the slug rules.
6. Insert the `users` row, create a session row, set the cookie, redirect to `/app`.

**Session cookie**
- Name: `drops_session`; value: the session id.
- Flags: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30 days`.
- Rolling expiry: each request extends `expires_at` when it is more than 24 hours old.

Middleware on every non-`/auth/*` route looks up the session, attaches `req.user`, and redirects to `/auth/login` on miss or expiry.

`POST /auth/logout` deletes the session row and clears the cookie.

## Upload Flow (Atomic Replace)

Endpoint: `POST /app/drops/:name/upload`, accepting a form field `upload_type=folder|zip`.

### Client — folder

1. User drags a folder onto the drop page.
2. The browser walks `DataTransferItemList` via `webkitGetAsEntry`, producing a flat list of `{relativePath, File}`.
3. Client-side validation: total ≤ 100 MB, file count ≤ 1000, each file ≤ 25 MB, no symlinks, skip dotfiles (`.DS_Store`, `.git/*`).
4. POSTs a single `multipart/form-data` request containing every file.

### Client — zip

1. User drops a single `.zip` file (or picks one via a file input).
2. Client POSTs it as a single `application/zip` part with `upload_type=zip`.

### Server

1. Auth check plus ownership check (must be the drop owner, or creating a new drop).
2. Allocate `version_id = uuid()` and `r2_prefix = drops/<drop_id>/<version_id>/`.
3. For `upload_type=folder`: stream each part to R2 at `${r2_prefix}${relativePath}`, setting `Content-Type` from the extension and tracking `byte_size` and `file_count`.
4. For `upload_type=zip`: stream-unzip with `yauzl` entry-by-entry. For each entry:
   - Skip directories.
   - Reject absolute paths, `..` segments, and symlinks (check `externalFileAttributes` for symlink mode).
   - Enforce the same per-file and total size limits against *decompressed* bytes.
   - Zip-bomb guard: abort if a single entry expands more than 100× its compressed size *and* exceeds 10 MB decompressed.
   - Stream the entry to R2 at `${r2_prefix}${cleanedPath}`.
   - Single-root unwrap: before upload, scan entries. If all paths share a common top-level directory (e.g. `my-site/...`), strip that prefix. Matches how `zip -r my-site.zip my-site/` works by convention.
5. If any write fails, delete every object written so far under `r2_prefix` and return an error. The drop continues to serve the old version.
6. On success, in a single transaction:
   - Insert the `drop_versions` row.
   - Capture `old_version_id = drops.current_version`.
   - Update `drops.current_version = new version_id` and bump `updated_at`.
7. Post-commit, enqueue garbage collection: list R2 objects under the old prefix, delete them, then delete the old `drop_versions` row. A nightly sweep retries any version row not referenced as a `current_version` on any drop.

### Limits

- Total ≤ 100 MB (compressed or decompressed).
- File count ≤ 1000.
- Each file ≤ 25 MB.

## Serving Drops

Route: `GET /:username/:dropname/*`, registered after `/auth` and `/app`.

1. Auth middleware runs first. Any authenticated user may view any drop.
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

**`GET /app/drops/new`** — create form with a drop-name input and a drag-drop zone. Submission creates an empty drop row, then runs the upload flow to produce the first version.

**`GET /app/drops/:name`** (owner only) — edit page. Shows current version metadata and a "Replace contents" drag-drop zone. A "Delete drop" button (with confirm) triggers `DELETE /app/drops/:name`, which removes the drop, version rows, and R2 prefix.

Non-owners hitting `/app/drops/:name` receive 403. They can still view the drop itself.

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

- CSRF: all state-changing routes require a same-origin check and a double-submit token in a form field, generated per session.
- `Content-Security-Policy` headers on `/app/*` pages only. None on served drops — their contents are user-controlled.
- `X-Frame-Options: DENY` on `/app/*`.
- Rate limiting on `/auth/*` and upload endpoints via `@fastify/rate-limit`.
- R2 keys strictly under the drop's prefix; path traversal rejected at the resolver.

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
