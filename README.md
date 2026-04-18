# drops

Private static-site host. Sign in with Google, drag a folder/zip/file, share the resulting URL with anyone on your allowlist. Each instance is single-tenant — one workspace per deploy, with a separate serving domain so user-uploaded HTML can't reach the control plane.

## Architecture

One Fastify + TypeScript service per instance, host-routed:

- **App origin** (`APP_ORIGIN`, e.g. `https://drops.example.com`) — auth, uploads, dashboard.
- **Content origin** (`CONTENT_ORIGIN`, e.g. `https://content.drops.example.com`) — serves the published drops.

Postgres holds metadata (Drizzle ORM). Cloudflare R2 holds files. Each upload writes to a fresh `drops/<versionId>/` prefix; a single `UPDATE` flips `drops.current_version` so readers never see a half-written drop. Orphaned prefixes are GC'd on a schedule.

## Local development

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

Postgres runs on `55432` locally to dodge conflicts with other Postgres installs. MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`).

For browser testing locally: set `APP_ORIGIN=http://drops.localtest.me:3000` and `CONTENT_ORIGIN=http://content.localtest.me:3000` in `.env` (both subdomains of `localtest.me` resolve to 127.0.0.1). Paste the cookies `pnpm dev:seed` prints into each origin's cookie jar.

## Tests

```bash
pnpm test        # unit + integration (needs docker compose up -d)
pnpm test:e2e    # Playwright happy path
pnpm typecheck
```

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

Each instance gets its own Railway project + Postgres + R2 bucket + Google OAuth client + DNS pair. The code doesn't change between instances — only env vars. Rough costs scale linearly with the number of instances.

## Security notes

- Session cookies are scoped per origin (app vs content) and transferred across the gap with a short-lived HMAC handoff token.
- CSRF tokens are bound to the session id (or pending-login id pre-signup) via HMAC plus an exact-origin check.
- Uploaded paths are NFC-normalised and rejected if they contain absolute roots, parent-segment traversal, control chars, or leading dots.
- Zip uploads are spooled to disk; symlink entries and bomb-ratio entries are rejected before any bytes hit R2.
