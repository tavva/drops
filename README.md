# drops-drops

Private static-site host for drops. The app origin (`drops.drops.global`) handles auth and uploads; the content origin (`content.drops.drops.global`) serves published drops to signed-in teammates.

## Architecture

One Fastify + TypeScript service. Postgres for metadata (Drizzle ORM), Cloudflare R2 for files. Each upload writes to a fresh `drops/<versionId>/` prefix; a single `UPDATE` flips `drops.current_version` so views never read a half-written drop. Orphaned prefixes are GC'd on a schedule.

## Local development

```bash
pnpm install
cp .env.example .env
# fill SESSION_SECRET with `openssl rand -hex 32`
docker compose up -d
pnpm db:migrate
pnpm dev
```

Postgres listens on `55432` locally to dodge conflicts with host-level Postgres / OrbStack. MinIO's console is at http://localhost:9001 (minioadmin/minioadmin).

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
| `R2_ENDPOINT` | Optional — set for MinIO/local; omit for Cloudflare R2 |
| `R2_ACCOUNT_ID` | R2 account id (used to derive the prod endpoint) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | R2 credentials + bucket |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client for `drops.global` workspace |
| `SESSION_SECRET` | 32+ char secret for signing cookies and handoff tokens |
| `ALLOWED_DOMAIN` | Email domain that is auto-allowed (others must be in `allowed_emails`) |
| `APP_ORIGIN` | e.g. `https://drops.drops.global` |
| `CONTENT_ORIGIN` | e.g. `https://content.drops.drops.global` |
| `PORT` | Defaults to 3000 |
| `LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error`/`silent` |

## Deployment (Railway)

1. Create a new Railway project from this repo.
2. Add the Postgres plugin and copy `DATABASE_URL` into the service env.
3. Create a Cloudflare R2 bucket and copy `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` into the service env. Leave `R2_ENDPOINT` unset so the default `https://<account>.r2.cloudflarestorage.com` is used.
4. Set `APP_ORIGIN=https://drops.drops.global`, `CONTENT_ORIGIN=https://content.drops.drops.global`, `SESSION_SECRET=$(openssl rand -hex 32)`, `ALLOWED_DOMAIN=drops.global`, `GOOGLE_CLIENT_ID`/`SECRET`.
5. Deploy — Railway reads the Dockerfile, which runs migrations before starting the server.
6. Add both custom domains (`drops.drops.global` and `content.drops.drops.global`) in Railway → pointed at the same service.
7. To allow an outside collaborator, run:
   ```bash
   railway run psql "$DATABASE_URL" -c "INSERT INTO allowed_emails (email) VALUES ('person@example.com');"
   ```

## Security notes

- Session cookies are scoped per origin (app vs content) and transferred across the gap with a short-lived HMAC handoff token.
- CSRF tokens are bound to the session id (or pending-login id pre-signup) via HMAC plus an exact-origin check.
- Uploaded paths are NFC-normalised and rejected if they contain absolute roots, parent-segment traversal, control chars, or leading dots.
- Zip uploads are spooled to disk; symlink entries and bomb-ratio entries are rejected before any bytes hit R2.
