# drops

[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Fastify](https://img.shields.io/badge/Fastify-5-000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

`drops` is a single-tenant private static-site host. Sign in with Google, drag a folder, zip, or file at the app origin, get a stable URL on a separate serving origin. Each deploy is one workspace — one Postgres, one R2 bucket, one allowlist.

Good for the things you don't want on your main app's domain: Storybook builds, exported designs, one-off preview links, screenshot bundles for clients.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Quick start (local)](#quick-start-local)
- [Tests](#tests)
- [Architecture](#architecture)
- [Environment](#environment)
- [Deployment (Railway)](#deployment-railway)
- [Multiple instances](#multiple-instances)
- [Security notes](#security-notes)
- [Licence](#licence)

## Features

- Drag-and-drop publishing. Folders, zips, single files.
- Atomic versions. Each upload writes to a fresh `drops/<versionId>/` prefix, then one `UPDATE` flips readers over. Nobody ever sees a half-written drop.
- Two-origin isolation. Control plane and serving plane run on separate hostnames in the same process, so uploaded HTML can't reach session cookies or upload routes.
- Google OAuth gated by `ALLOWED_DOMAIN`. Outside collaborators go in the `allowed_emails` table; there's no admin UI.
- Path hardening (NFC normalisation, no traversal, no control chars, no leading dots) and zip hardening (no symlinks, bomb-ratio rejection).
- Background GC sweeps orphaned R2 prefixes — failed uploads, replaced versions.
- One workspace per deploy. No multi-tenancy, no plans for any.

## How it works

```
       ┌────────────────────┐                ┌────────────────────────────┐
You ──▶│  APP_ORIGIN        │                │  <user>--<drop>.CONTENT_…  │
       │  drops.example.com │                │  (one subdomain per drop) │
       │                    │                │                            │
       │  • Google OAuth    │  host-bound    │  • Serves that drop only   │
       │  • Dashboard       │  handoff  ───▶ │  • Cookie scoped to host   │
       │  • Uploads         │                │  • No CSP (user HTML)      │
       └────────┬───────────┘                └──────────┬─────────────────┘
                │                                       │
                ▼                                       ▼
       ┌────────────────────┐                ┌────────────────────────────┐
       │  Postgres          │                │  Cloudflare R2             │
       │  (Drizzle schema)  │                │  drops/<versionId>/        │
       └────────────────────┘                └────────────────────────────┘
```

Both the app origin and the drop subdomains are routed by the same Fastify process; `req.hostKind` is `app`, `content` (apex — legacy-URL redirects only), or `drop` (a parsed `<user>--<drop>.<root>` subdomain). Each drop has its own origin, so hostile HTML in one drop cannot use same-origin `fetch` to read another drop the victim is authorised for.

The content apex (`CONTENT_ORIGIN`) now only serves 301 redirects from pre-cutover URLs `/<user>/<drop>/…` to the new per-drop subdomain. The serving cookie lives on the drop's subdomain only (`Domain=<user>--<drop>.<root>`) and is bound in both the HMAC payload and the browser's cookie scoping to that exact host.

First-time visit flow: drop host has no cookie → bounce to app `/auth/drop-bootstrap?host=…&next=…` → app mints a handoff bound to `(sessionId, drophost)` → browser lands on `<drophost>/auth/bootstrap?token=…` → drop host sets its own cookie → redirects to the requested path. Subsequent visits to the same drop are cookie-served.

## Quick start (local)

Prerequisites: Node ≥ 22, pnpm, Docker.

```bash
pnpm install
cp .env.example .env
# fill SESSION_SECRET with `openssl rand -hex 32`
docker compose up -d
pnpm db:migrate
pnpm dev:init-bucket    # one-off: creates the R2 bucket in MinIO
pnpm dev:seed           # prints a signed cookie so you can skip OAuth locally
pnpm dev
```

Postgres runs on `55432` locally to dodge conflicts with other Postgres installs. MinIO console: <http://localhost:9001> (`minioadmin` / `minioadmin`).

For browser testing locally, set both origins to subdomains of `localtest.me` (which resolves to `127.0.0.1`):

```env
APP_ORIGIN=http://drops.localtest.me:3000
CONTENT_ORIGIN=http://content.localtest.me:3000
```

Paste the cookies `pnpm dev:seed` prints into each origin's cookie jar.

## Tests

```bash
pnpm test        # unit + integration (needs docker compose up -d)
pnpm test:e2e    # Playwright happy path
pnpm typecheck
pnpm lint
```

Integration tests share one vitest worker (`pool: 'forks'`, `fileParallelism: false`) and a once-per-run rebuild of the test database — don't try to parallelise them across files.

## Architecture

One Fastify + TypeScript service per instance, host-routed:

- **App origin** (`APP_ORIGIN`) — auth, uploads, dashboard.
- **Content origin** (`CONTENT_ORIGIN`) — serves the published drops.

Cookies are scoped per origin, so logging into the app doesn't grant anything on the content origin. To hand off a session across the gap, the app issues a short-lived HMAC token (`src/lib/handoff.ts`, payload `sessionId:exp`) and the content origin's bootstrap route verifies it and sets its own cookie. There is no shared cookie domain.

Postgres holds metadata via Drizzle ORM. Cloudflare R2 holds files. Each upload writes to a fresh `drops/<versionId>/` prefix, then a single `UPDATE drops SET current_version = ...` flips readers over. `src/services/gc.ts` + `scheduler.ts` sweep orphaned prefixes (versions that never became current, or previous versions after replacement). `startOrphanSweep()` is kicked off from `src/index.ts` on boot.

Routes are wired in `src/index.ts` against `onAppHost` / `onContentHost` plugin wrappers — that's the single place new routes get bound to a host.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `R2_ENDPOINT` | Optional — set to MinIO for local dev; leave unset in prod |
| `R2_ACCOUNT_ID` | Cloudflare R2 account id (used to derive the prod endpoint) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | R2 credentials + bucket |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth Web client |
| `SESSION_SECRET` | 32+ char secret for signing cookies and handoff tokens |
| `ALLOWED_DOMAIN` | Email domain that is auto-allowed (non-matching emails must appear in `allowed_emails`) |
| `APP_ORIGIN` | Full URL of the auth/upload origin |
| `CONTENT_ORIGIN` | Full URL of the content-serving origin |
| `PORT` | Defaults to 3000 |
| `LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error`/`silent` |

## Deployment (Railway)

1. Create a Railway project and add a Postgres plugin.
2. Deploy this repo as a service. Railway reads the Dockerfile.
3. Create a Cloudflare R2 bucket and an API token scoped to it. Copy the four `R2_*` vars.
4. Create a Google OAuth Web client with redirect URI `https://drops.<your-domain>/auth/callback`.
5. Set env vars on the Railway service:
   - `SESSION_SECRET=$(openssl rand -hex 32)`
   - `ALLOWED_DOMAIN=<your-company.com>`
   - `APP_ORIGIN=https://drops.<your-domain>`
   - `CONTENT_ORIGIN=https://content.drops.<your-domain>`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
6. Add custom domains on the service:
   - `drops.<your-domain>` (CNAME to the target Railway gives you).
   - `content.drops.<your-domain>` (same target).
   - `*.content.drops.<your-domain>` — Railway Pro supports wildcard custom domains. Add a wildcard `CNAME *.content.drops.<your-domain> → <railway-target>` at your DNS provider. Railway issues a Let's Encrypt wildcard cert via DNS-01 once the record resolves.
7. Deploy. The Dockerfile's CMD runs migrations before starting the server.
8. To allow an extra collaborator from outside `ALLOWED_DOMAIN`:
   ```bash
   railway run psql "$DATABASE_URL" -c "INSERT INTO allowed_emails (email) VALUES ('person@example.com');"
   ```

## Multiple instances

Each instance gets its own Railway project + Postgres + R2 bucket + DNS pair. The code doesn't change between instances — only env vars. Costs scale roughly linearly with the number of instances.

A single Google OAuth Web client can be shared across instances: add one redirect URI per deployment (e.g. `https://drops.example.com/auth/callback`, `https://drops.other.com/auth/callback`). The same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` values go on every instance. Tradeoff: the secret's blast radius now covers every instance, so if one deployment leaks its env, rotate the shared client.

## Security notes

- Each drop is served on its own subdomain (`<user>--<drop>.<content-root>`). The serving cookie is scoped to that exact host and signed with a host-bound HMAC, so hostile HTML in one drop cannot use same-origin `fetch` to read another drop.
- The app origin and each drop subdomain have their own cookies; handoff tokens are bound to both `sessionId` and target host, and expire in 60 s.
- CSRF tokens on the app origin are bound to the session id (or pending-login id pre-signup) via HMAC plus an exact-origin match.
- Uploaded paths are NFC-normalised and rejected if they contain absolute roots, parent-segment traversal, control chars, or leading dots.
- Zip uploads are spooled to disk; symlink entries and bomb-ratio entries are rejected before any bytes hit R2.

## Licence

MIT — see [LICENSE](LICENSE).
