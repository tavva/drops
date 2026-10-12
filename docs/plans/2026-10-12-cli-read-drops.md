# CLI Read Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `drops cat` prints one file from any drop the caller can view, `drops pull` downloads a whole drop atomically into a local directory, and `drops list --all` finds drops shared with the caller.

**Architecture:** The CLI read routes move from `src/routes/cli/list.ts` to `src/routes/cli/read.ts`. Two owner-addressed routes (`/api/v1/drops/:owner/:name/files` and `/content/*`) share one lookup that finds the owner by username, the drop by owner and name, and applies `canView`; every refusal is the same 404. The CLI gains a `read.ts` orchestration module (reference parsing, credential lookup, `cat`, `pull`) with injectable dependencies, matching `list.ts` and `deploy.ts`.

**Tech Stack:** Fastify + Drizzle + R2 (server), Node `parseArgs` + fetch + `fs/promises` (CLI), vitest integration tests, Playwright e2e.

Design doc: `docs/plans/2026-10-12-cli-read-drops-design.md`.

**Note:** this plan predates the `drops view` command on `main`. The built feature follows the design doc: no `cat`, pull reads through the existing content route, and the owner files route uses `?owner=`.

**Deviation from the design, decided while planning:** the content route gets its own rate limit (2400 requests a minute per IP) instead of the global 120. Pull fetches one request per file and drops may hold up to 1000 files (`UPLOAD_LIMITS.fileCount`), so the global limit would fail every pull of a drop with more than ~119 files. 2400 covers a full 1000-file pull plus its one restart.

**Second deviation:** the CLI validates the `cat` path locally with the same rules as pulled paths. Without it, `..` segments would be collapsed by URL parsing in `fetch` (including `%2E%2E`) and the request would reach a different API route.

---

### Task 1: Server — rename list routes to read routes, add `owner` and `scope=all`

**Files:**
- Rename: `src/routes/cli/list.ts` → `src/routes/cli/read.ts` (export `cliReadRoutes`)
- Modify: `src/routes/appHost.ts`
- Rename: `tests/integration/cli-list-routes.test.ts` → `tests/integration/cli-read-routes.test.ts`

**Step 1:** `git mv` both files, update imports and the export name, update ABOUTME lines. Run `pnpm test -- tests/integration/cli-read-routes.test.ts`; expect PASS (pure rename).

**Step 2: failing tests** in the `GET /api/v1/drops` describe:
- the existing whole-entry `toEqual` gains `owner: 'alice'`;
- `?scope=mine` behaves like the default;
- `?scope=all` returns own drops plus a `public` drop, an `authed` drop and an `emails` drop listing alice, but not bob's `emails` drop without alice, each with `owner` and `url` built from the owner's username;
- `?scope=everything` → 400 `invalid_scope`.

Run; expect FAIL.

**Step 3: implement.** Add `invalid_scope` to the error codes. Map both scopes through one `toListEntry(drop, ownerUsername)`; `scope=all` uses `listAllVisibleUnpaged({ id, email })`, `mine` uses `listByOwner` with the caller's username.

**Step 4:** tests pass; commit `feat(api): list every drop a CLI user can view`.

### Task 2: Server — owner-addressed files and content routes

**Files:** `src/routes/cli/read.ts`, `tests/integration/cli-read-routes.test.ts`

**Step 1: failing tests** — new describes for `GET /api/v1/drops/:owner/:name/files` and `GET /api/v1/drops/:owner/:name/content/*`, with bob owning drops in each view mode:
- 401 without a token (both routes);
- invalid owner or name slug → 400 `invalid_name`;
- own drop, `public`, `authed`, `emails` with alice listed, `emails` with `includeDomain` (alice at `ALLOWED_DOMAIN`, so her email must be `@example.com` in that case) are readable;
- `emails` without alice, unknown owner and unknown drop all return byte-identical 404 `drop_not_found` bodies;
- files response is `{ instance, owner, name, versionId, files }`; a drop with no current version returns `versionId: null, files: []`;
- content returns exact bytes, `content-type`, `content-length`, `x-drops-version`;
- missing file and no current version → 404 `file_not_found`;
- `..` (encoded as `%2E%2E`), control characters, and an empty path → 400 `invalid_path`;
- `?version=<current>` → 200, `?version=<other>` → 409 `version_changed`;
- no index fallback: `content/sub` does not serve `sub/index.html`;
- 130 content requests in a row all succeed (above the global limit of 120);
- the existing `/api/v1/drops/:name/files` tests stay unchanged.

**Step 2: implement.**

```ts
async function findViewableDrop(user: { id: string; email: string }, ownerName: string, name: string) {
  const owner = await findByUsername(ownerName);
  if (owner === null) return null;
  const drop = await findByOwnerAndName(owner.id, name);
  if (drop === null) return null;
  return await canView(user, drop) ? drop : null;
}

async function fileEntries(drop: DropSummary) { /* listPrefixObjects, [] without a version */ }
```

Content route: `config: { rateLimit: { max: 2400, timeWindow: '1 minute' } }`, `sanitisePath` on the wildcard (reject → 400 `invalid_path`), version check before the R2 read, then `getObject(prefix + path)` and stream with headers.

**Step 3:** tests pass; commit `feat(api): read files from any drop a CLI user can view`.

### Task 3: CLI — API client methods

**Files:** `packages/cli/src/api.ts`, `packages/cli/tests/api.test.ts`

**Step 1: failing tests** with an injected fetch:
- `listDrops(origin, token, { all: true })` calls `/api/v1/drops?scope=all`; default URL unchanged; items require `owner`;
- `readDropFiles(origin, token, owner, name)` calls the owner route with encoded parts, validates `{ instance, owner, name, versionId, files }`, maps 404 to `drop_not_found` exit 4;
- `readDropFile(origin, token, owner, name, path, versionId?)` encodes each path segment, appends `?version=`, returns `{ versionId, body }` from `x-drops-version`; 404 `file_not_found` → `file_not_found` exit 4; other 404 → `drop_not_found` exit 4; 409 → `version_changed` exit 4; missing header → `server_error`.

**Step 2:** implement; commit `feat(cli): add API client methods for reading drops`.

### Task 4: CLI — references, shared credential lookup, `list --all` and `list owner/name`

**Files:** create `packages/cli/src/read.ts`; modify `packages/cli/src/list.ts`, `packages/cli/src/commands/list.ts`, `packages/cli/src/errors.ts`; tests `packages/cli/tests/read.test.ts`, `packages/cli/tests/list.test.ts`.

- `parseDropReference(value, example)`: `name` → `{ name }`, `owner/name` → `{ owner, name }`; bare invalid → `invalid_name`; anything else containing `/` that is not two slugs → `invalid_reference` (exit 2).
- `authenticatedInstance({ cwd, instance }, dependencies, action)` returns `{ origin, token }`; `list` uses it instead of its inline copy.
- `list` accepts `all`; `list --all name` → usage error; `owner/name` calls `readDropFiles`; renders `OWNER/NAME` in the first column for `--all`.

Commit `feat(cli): list shared drops and other users' drop files`.

### Task 5: CLI — `drops cat`

**Files:** `packages/cli/src/read.ts`, create `packages/cli/src/commands/read.ts`, modify `packages/cli/src/index.ts`, `packages/cli/src/output.ts` (`TextWriter.write` accepts bytes and a completion callback); tests in `packages/cli/tests/read.test.ts`.

- `safeRelativePath(path)` rejects empty, absolute, `\`, control characters, and empty / `.` / `..` segments.
- `cat({ cwd, reference, path, instance }, deps)` resolves a bare name through `whoami`, validates the path, returns the `readDropFile` result.
- `parseCatArguments` accepts exactly two positionals and `--instance`; `--json` is an unknown option.
- `CommandResult` gains optional `content`; `runCli` writes each chunk to stdout, awaiting the write callback, with no trailing newline.

Tests: exact binary bytes reach stdout, whoami only for bare names, hostile path rejected before network, `--json` rejected, server 404 reaches stderr with exit 4.

Commit `feat(cli): add cat command`.

### Task 6: CLI — `drops pull`

**Files:** `packages/cli/src/read.ts`, `packages/cli/src/commands/read.ts`, `packages/cli/src/index.ts`, tests.

- `pull({ cwd, reference, directory, instance }, deps)`; target defaults to `./<name>`; refuses an existing non-empty directory or a non-directory (`directory_not_empty`, exit 2).
- Validates every listed path before writing; writes into `.<base>.drops-pull-<uuid>` next to the target, registered with the lifecycle cleanup; renames onto the target only when every file has arrived; removes the temporary directory on any failure.
- On `version_changed` restarts once; a second change is an error.
- Result `{ instance, owner, name, versionId, directory, fileCount, byteSize }`; human line `Pulled owner/name (N files, size) to <directory>`.

Tests use a real temp directory and an injected API: success layout, empty existing dir allowed, non-empty refused, hostile path rejected and nothing written, restart once on 409, second 409 fails and cleans up, mid-download failure cleans up, JSON and human output.

Commit `feat(cli): add pull command`.

### Task 7: Help and READMEs

`help.ts` gains `cat` and `pull` entries and `--all` / `owner/name` on `list`, with notes that only drops you can view in the browser are readable. Update `help.test.ts` command list and list usage. Document in `README.md` and `packages/cli/README.md`.

Commit `docs(cli): document cat, pull and list --all`.

### Task 8: e2e journey

`tests/e2e/helpers/cli-child.mjs` injects `read` dependencies with the file credential store. `tests/e2e/cli.spec.ts`: after deploy, a second user's drop is created (public) through the services; the journey runs `list --all --json` (sees both with owners), `cat cli-preview asset.txt` (exact bytes), `cat <other>/<drop> index.html`, `pull cli-preview <dir> --json` and checks files on disk. The smoke test asserts `cat` and `pull` in `help --json`.

Commit `test(e2e): cover cat, pull and list --all`.

### Task 9: Verification and release

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm cli:typecheck`, `pnpm cli:test`, `pnpm cli:pack:check`, `pnpm test:e2e`, `pnpm build`; code review; merge to `main` with `Merge: ...`; push; watch the four Railway deployments; smoke-check without credentials; `pnpm cli:build`.
