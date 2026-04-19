# drops

[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Fastify](https://img.shields.io/badge/Fastify-5-000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

> Private static-site host for one workspace. Sign in with Google, drag a folder, share the URL.

`drops` is a single-tenant Fastify service for hosting throwaway and long-lived static sites behind your team's allowlist. Upload a folder, zip, or single file and you get a stable URL on a separate serving domain — so user-uploaded HTML can never reach the control plane.

It's the thing you reach for when you want to share a Storybook build, an exported design, a one-page demo, or a screenshot bundle without standing up a CDN, configuring access policies, or polluting your main app's origin.

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

- **Drag-and-drop publishing** — upload a folder, zip, or single file from the dashboard.
- **Atomic versions** — each upload is a fresh prefix in R2; readers cut over with a single `UPDATE` and never see a half-written drop.
- **Two-origin isolation** — control plane and serving plane are separate hostnames on the same process, so user HTML can't touch session cookies or upload routes.
- **Google sign-in + allowlist** — auto-allow by email domain, opt-in extras via the `allowed_emails` table.
- **Hardened paths and zips** — NFC-normalised paths, rejected traversal/control chars, symlink and zip-bomb protections.
- **Background GC** — orphaned R2 prefixes from failed uploads or replaced versions are swept on a schedule.
- **Single-tenant by design** — one Postgres + one R2 bucket per deploy. No cross-tenant blast radius.

## How it works

```
       ┌────────────────────┐                  ┌─────────────────────┐
You ──▶│  APP_ORIGIN        │                  │  CONTENT_ORIGIN     │
       │  drops.example.com │                  │  content.drops.…    │
       │                    │                  │                     │
       │  • Google OAuth    │  HMAC handoff    │  • Serves drops     │
       │  • Dashboard       │ ───────────────▶ │  • Per-origin       │
       │  • Uploads         │                  │    session cookie   │
       └────────┬───────────┘                  └──────────┬──────────┘
                │                                         │
                ▼                                         ▼
       ┌────────────────────┐                  ┌─────────────────────┐
       │  Postgres          │                  │  Cloudflare R2      │
       │  (Drizzle schema)  │                  │  drops/<versionId>/ │
       └────────────────────┘                  └─────────────────────┘
```

Both origins are routed by the same Fastify process; `req.hostKind` decides which routes are reachable on which host.

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

Cookies are scoped per origin, so logging into the app doesn't grant anything on the content origin. To hand off a session across the gap, the app issues a short-lived HMAC token (`src/lib/handoff.ts`, payload `sessionId:exp`) and the content origin's bootstrap route verifies it and sets its own cookie. There is no shared cookie domain by design.

Postgres holds metadata via Drizzle ORM. Cloudflare R2 holds files. Each upload writes to a fresh `drops/<versionId>/` prefix, then a single `UPDATE drops SET current_version = ...` flips readers over atomically. `src/services/gc.ts` + `scheduler.ts` sweep orphaned prefixes (versions that never became current, or previous versions after replacement). `startOrphanSweep()` is kicked off from `src/index.ts` on boot.

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
6. Add custom domains on the service: `drops.<your-domain>` and `content.drops.<your-domain>` (CNAME to the target Railway gives you).
7. Deploy. The Dockerfile's CMD runs migrations before starting the server.
8. To allow an extra collaborator from outside `ALLOWED_DOMAIN`:
   ```bash
   railway run psql "$DATABASE_URL" -c "INSERT INTO allowed_emails (email) VALUES ('person@example.com');"
   ```

## Multiple instances

Each instance gets its own Railway project + Postgres + R2 bucket + DNS pair. The code doesn't change between instances — only env vars. Costs scale roughly linearly with the number of instances.

A single Google OAuth Web client can be shared across instances: add one redirect URI per deployment (e.g. `https://drops.example.com/auth/callback`, `https://drops.other.com/auth/callback`). The same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` values go on every instance. Tradeoff: the secret's blast radius now covers every instance, so if one deployment leaks its env, rotate the shared client.

## Security notes

- Session cookies are scoped per origin (app vs content) and transferred across the gap with a short-lived HMAC handoff token.
- CSRF tokens are bound to the session id (or pending-login id pre-signup) via HMAC plus an exact-origin match.
- Uploaded paths are NFC-normalised and rejected if they contain absolute roots, parent-segment traversal, control chars, or leading dots.
- Zip uploads are spooled to disk; symlink entries and bomb-ratio entries are rejected before any bytes hit R2.

## Licence

MIT — see [LICENSE](LICENSE).
