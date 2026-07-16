# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

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
pnpm test:e2e            # builds the CLI, then runs Playwright system tests
pnpm cli:build            # build @tavva/drops-cli to packages/cli/dist
pnpm cli:test             # CLI unit/integration tests with test credential stores
pnpm cli:typecheck        # CLI-only TypeScript check
pnpm cli:pack:check       # clean pack and verify the published executable shebang
pnpm cli:test:keychain    # OPT-IN: touches the developer's live macOS Keychain
pnpm db:generate         # drizzle-kit generate (after schema.ts changes)
pnpm db:migrate          # apply migrations (also run by Docker CMD in prod)
pnpm dev:init-bucket     # one-off: create the R2 bucket in MinIO
pnpm dev:seed            # prints a signed cookie to skip OAuth locally
```

Integration tests need `docker compose up -d` (Postgres on `55432`, MinIO on `9000`/`9001`). `tests/helpers/global-setup.ts` rebuilds the test DB once per vitest run; `pool: 'forks'` with `fileParallelism: false` means tests run in a single worker in series — don't try to parallelise them across files. TEST_ENV in `tests/helpers/env.ts` overrides `process.env` for every worker.

`pnpm test:e2e` builds the CLI before starting Playwright. CLI coverage is layered: one smoke test runs the built executable without injected modules through help, init, and deploy validation failures that stop before credential lookup; the full status/deploy/login journey injects test-only file credential and browser-opening adapters so it cannot touch Keychain or launch a real browser. Child processes are bounded and force-reaped on failure. Only run `pnpm cli:test:keychain` when live Keychain mutation is explicitly intended.

## Architecture

**Three host kinds, one process.** `APP_ORIGIN` is the control plane (auth, dashboard, uploads). `CONTENT_ORIGIN` is the apex of the serving plane — post-cutover it only serves `GET /:user/:drop[/*] → 301 <user>--<drop>.<root>/<*>` legacy redirects. Every drop lives at its own subdomain `<username>--<dropname>.<content-root>`, and the whole wildcard is routed by the same Fastify process. `src/server.ts` sets `req.hostKind` ∈ `{app, content, drop, unknown}` plus `req.dropHost` when the subdomain parses, and `src/middleware/host.ts` exposes `onAppHost` / `onContentHost` / `onDropHost` plugin wrappers that 404 requests on the wrong host. App-host route modules are registered in `src/routes/appHost.ts`, which both `src/index.ts` and the e2e helper server (`tests/e2e/helpers/full-server.ts`) use — add new app routes there and they reach production and e2e together. Content- and drop-host wiring stays in `src/index.ts`.

**Per-drop origin isolation.** Each drop has its own origin so hostile user HTML in one drop can't `fetch` a sibling drop with the victim's cookie. The drop-serve cookie (`drops_drop_session`) is scoped via `Domain=<exact-drop-host>` and its signed payload includes the host, so server-side verification rejects cookies replayed against a different drop host (`verifyDropCookie` in `src/lib/cookies.ts`).

**Session handoff between hosts.** The app origin mints short-lived HMAC tokens (`src/lib/handoff.ts`, payload `sessionId|host|exp`) that are consumed by the drop host's `/auth/bootstrap`. `verifyHandoff` requires the expected host — tokens minted for one drop can't be replayed on another. The bootstrap flow is per-drop: a drop host with no cookie bounces the browser to app-side `/auth/drop-bootstrap?host=…&next=…` (`src/routes/auth/dropBootstrap.ts`) which re-checks `canView` then issues the host-bound token. Load-bearing abstractions: `parseDropHost` / `dropHostFor` / `dropOriginFor` in `src/lib/dropHost.ts`, `requireDropSession` in `src/middleware/auth.ts`.

**CSRF.** Tokens are bound to the session id (or the pending-login id pre-signup) via HMAC and checked alongside an exact-origin match. See `src/lib/csrf.ts` and `src/middleware/csrf.ts`.

**Upload → R2 atomicity.** Each upload writes to a fresh `drops/<versionId>/` prefix, then a single `UPDATE drops SET current_version = ...` flips readers over. Readers never see a partial drop. `src/services/gc.ts` + `scheduler.ts` sweep orphaned prefixes (versions that never became current, or previous versions after replacement). `startOrphanSweep()` is kicked off from `src/index.ts` on boot.

**Agent CLI.** `packages/cli` builds the separate `@tavva/drops-cli` executable. It discovers an exact app origin from `--instance` or a secret-free repository `.drops.json`, uses browser-approved PKCE login, and stores one bearer credential per exact origin in macOS Keychain. Server-side token hashes and revocation state live in `cli_tokens`; bearer API routes perform identity checks and stream zip deployments through the same atomic deployment service as browser uploads. Dashboard revocation is owner-scoped and CSRF-protected. The CLI never receives direct database or R2 credentials.

**Path/zip hardening.** `src/lib/path.ts` NFC-normalises paths and rejects absolute roots, parent traversal, control chars, and leading dots. `src/services/uploadZip.ts` spools zips to disk and rejects symlink entries plus bomb-ratio entries before anything reaches R2. Don't relax these checks.

**Allowlist.** Auth gate is `ALLOWED_DOMAIN` (auto-allow by email domain) OR a row in `allowed_emails`. Outside collaborators are added by inserting into that table — there is no admin UI.

**Schema note.** `drops.current_version` has a composite FK to `drop_versions(id, drop_id)` added via a raw SQL step inside the migration (not expressible via Drizzle column helpers). Keep this in mind when regenerating migrations.

## Conventions

- ESM only (`"type": "module"`). Imports use `@/*` → `src/*` (tsconfig paths; `tsc-alias` rewrites in the build output).
- Every `.ts` file starts with two `// ABOUTME: ` lines — preserve this on edits.
- Node ≥ 22.
- Views are EJS (`src/views/*.ejs`), rendered via `@fastify/view`.
- British English in user-facing copy.
- **No inline JS/CSS in views.** The app host sends a strict CSP (`script-src`/`style-src 'self'`, no nonce), which silently blocks inline `<script>`, `on*=` handlers, and `style=` attributes. Put behaviour in `src/views/static/*.js` (served from `/app/static/`, loaded as `<script type="module" src=…>`), drive former inline handlers off `data-*` attributes, and put styles in `style.css`. `tests/unit/views-csp.test.ts` fails if a template regains any inline script/handler/style.

## Deployment

The application supports independent instances, each with separate Postgres, R2, and DNS resources. The code is identical across instances; only environment variables differ. Builds use this repository's `Dockerfile`, whose `CMD` runs `db:migrate` before starting the server, so migrations apply automatically on every deploy.

Set `PORT=3000` explicitly when the wildcard custom domain targets port 3000. Otherwise Railway may route drop subdomains to a different detected port while the app origin continues to work.

To deploy a single instance without pushing `main`, link the Railway CLI to that service and deploy a snapshot:

```bash
railway link --project <projectID> --environment <envID> --service <serviceID>
railway up --detach -m "<summary>"
railway deployment list --json
```

Smoke-check a deploy with an authenticated static asset or another path that distinguishes the new build from the old one.

Maintainer-specific instance inventory, rollout warnings, and smoke-check URLs belong in ignored `CLAUDE.local.md`, never in tracked files.
