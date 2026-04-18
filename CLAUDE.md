# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-tenant private static-site host. One Fastify + TypeScript service per instance, backed by Postgres (Drizzle) and Cloudflare R2. Users sign in with Google, upload a folder/zip/file, share the resulting URL. See `README.md` for deployment context.

## Commands

```bash
pnpm dev                 # tsx watch, reads .env
pnpm build               # tsc -> dist/ (tsc-alias resolves @/* paths)
pnpm start               # node dist/index.js (uses compiled build)
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint .
pnpm test                # vitest (unit + integration; needs docker compose up -d)
pnpm test:watch
pnpm test -- tests/unit/path.test.ts            # single file
pnpm test -- -t "rejects parent traversal"      # by test name
pnpm test:e2e            # playwright (happy path)
pnpm db:generate         # drizzle-kit generate (after schema.ts changes)
pnpm db:migrate          # apply migrations (also run by Docker CMD in prod)
pnpm dev:init-bucket     # one-off: create the R2 bucket in MinIO
pnpm dev:seed            # prints a signed cookie to skip OAuth locally
```

Integration tests need `docker compose up -d` (Postgres on `55432`, MinIO on `9000`/`9001`). `tests/helpers/global-setup.ts` rebuilds the test DB once per vitest run; `pool: 'forks'` with `fileParallelism: false` means tests run in a single worker in series — don't try to parallelise them across files. TEST_ENV in `tests/helpers/env.ts` overrides `process.env` for every worker.

## Architecture

**Two origins, one process, host-routed.** `APP_ORIGIN` (auth/dashboard/upload) and `CONTENT_ORIGIN` (serves published drops) are separate hostnames pointing at the same Fastify instance. This keeps user-uploaded HTML out of the control-plane origin. `src/server.ts` sets `req.hostKind` ∈ `{app, content, unknown}` from the `Host` header, and `src/middleware/host.ts` exposes `onAppHost` / `onContentHost` plugin wrappers that 404 requests on the wrong host. `src/index.ts` is the single place where route modules get wired onto the correct host — add new routes there.

**Session handoff between origins.** Cookies are scoped per origin. To carry a login from app → content, the app issues a short-lived HMAC token (`src/lib/handoff.ts`, payload `sessionId:exp`) and the content origin's bootstrap route verifies it and sets its own cookie. Don't bypass this — there is no shared cookie domain.

**CSRF.** Tokens are bound to the session id (or the pending-login id pre-signup) via HMAC and checked alongside an exact-origin match. See `src/lib/csrf.ts` and `src/middleware/csrf.ts`.

**Upload → R2 atomicity.** Each upload writes to a fresh `drops/<versionId>/` prefix, then a single `UPDATE drops SET current_version = ...` flips readers over. Readers never see a partial drop. `src/services/gc.ts` + `scheduler.ts` sweep orphaned prefixes (versions that never became current, or previous versions after replacement). `startOrphanSweep()` is kicked off from `src/index.ts` on boot.

**Path/zip hardening.** `src/lib/path.ts` NFC-normalises paths and rejects absolute roots, parent traversal, control chars, and leading dots. `src/services/uploadZip.ts` spools zips to disk and rejects symlink entries plus bomb-ratio entries before anything reaches R2. Don't relax these checks.

**Allowlist.** Auth gate is `ALLOWED_DOMAIN` (auto-allow by email domain) OR a row in `allowed_emails`. Outside collaborators are added by inserting into that table — there is no admin UI.

**Schema note.** `drops.current_version` has a composite FK to `drop_versions(id, drop_id)` added via a raw SQL step inside the migration (not expressible via Drizzle column helpers). Keep this in mind when regenerating migrations.

## Conventions

- ESM only (`"type": "module"`). Imports use `@/*` → `src/*` (tsconfig paths; `tsc-alias` rewrites in the build output).
- Every `.ts` file starts with two `// ABOUTME: ` lines — preserve this on edits.
- Node ≥ 22.
- Views are EJS (`src/views/*.ejs`), rendered via `@fastify/view`.
- British English in user-facing copy.
