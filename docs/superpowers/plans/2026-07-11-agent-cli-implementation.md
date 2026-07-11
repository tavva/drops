# Authenticated Agent CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS `drops` CLI that a human authorises against one or more Drops instances, then local agents can use to publish explicitly named drops through the existing atomic upload pipeline.

**Architecture:** Add a separate `@tavva/drops-cli` workspace package whose `drops` binary resolves a canonical instance from `--instance` or `.drops.json`, stores one bearer token per origin in macOS Keychain, packages local content as zip, and speaks a versioned JSON API. On the server, add short-lived PKCE authorisation codes and hashed CLI tokens, browser approval and revocation UI, bearer middleware, and an API upload transport that shares a newly extracted atomic deployment service with the browser route.

**Tech Stack:** Node.js 22, TypeScript, pnpm workspaces, Fastify 5, Drizzle/Postgres, EJS, macOS `security`, native `fetch`/`http`/`crypto`, `yazl`, Vitest, Playwright.

---

## File and boundary map

The implementation is split by responsibility so server transports, deployment
state changes, and local CLI concerns remain independently testable.

### CLI package (`packages/cli`)

- `package.json`, `tsconfig.json`, `vitest.config.ts`: standalone package/build/test configuration; publishes `dist/index.js` as the `drops` binary.
- `src/index.ts`: parses commands with `node:util.parseArgs`, dispatches commands, applies the shared output/exit contract.
- `src/errors.ts`: stable error codes, exit categories, JSON error serialization, and secret-safe messages.
- `src/instance.ts`: canonical origin validation and flag/repository resolution.
- `src/config.ts`: `.drops.json` read/write and ancestor search only; contains no secret state.
- `src/keychain.ts`: injected credential-store interface plus macOS Keychain implementation.
- `src/api.ts`: same-origin, no-follow HTTP client and typed v1 responses.
- `src/auth.ts`: PKCE, loopback listener, browser opening, login/re-login/logout/status orchestration.
- `src/packageSource.ts`: file/directory/zip preflight, symlink refusal, temporary zip creation and cleanup.
- `src/deploy.ts`: upload progress, bearer request, and deploy result handling.
- `src/output.ts`: exact human/JSON stdout and stderr contract.
- `src/commands/*.ts`: thin command adapters for `init`, `login`, `logout`, `auth status`, and `deploy`.
- `tests/*.test.ts`: unit tests with injected filesystem, process runner, browser opener, fetch, and credential store seams.

### Server

- `src/db/schema.ts` and migration `0006_*`: `cli_authorization_codes` and `cli_tokens`.
- `src/services/cliAuth.ts`: code/token hashing, issue/exchange, lookup, throttled last-used update, self/dashboard revocation, expiry cleanup.
- `src/middleware/cliAuth.ts`: strict bearer parsing and completed-member resolution.
- `src/routes/cli/discovery.ts`: unauthenticated `/.well-known/drops` metadata.
- `src/routes/cli/authorize.ts` and `src/views/cliAuthorize.ejs`: session + CSRF browser approval and denial.
- `src/routes/cli/apiAuth.ts`: token exchange, whoami, and self-revoke JSON API.
- `src/routes/cli/deploy.ts`: bearer-authenticated raw-zip API transport.
- `src/services/deployments.ts`: transport-independent DB version swap, immediate prefix cleanup after commit failure, and old-version GC scheduling.
- `src/routes/app/upload.ts`: retains multipart/browser behavior but delegates commit to `deployments.ts`.
- `src/routes/app/cliTokens.ts`, `src/views/dashboard.ejs`, `src/views/static/style.css`: list and revoke CLI authorisations.
- `src/services/scheduler.ts`: delete expired/consumed CLI authorisation codes.
- `src/index.ts`: app-host-only registration of all new routes.

## Commit-date requirement

Every commit created by this plan must set both author and committer dates to
11 July 2026 in Europe/London. Use the exact environment variables shown in each
task. Review/fix commits must use another time on the same date; never create a
12 July commit.

---

### Task 1: CLI workspace, error contract, and instance configuration

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/errors.ts`
- Create: `packages/cli/src/instance.ts`
- Create: `packages/cli/src/config.ts`
- Create: `packages/cli/src/output.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/tests/instance.test.ts`
- Create: `packages/cli/tests/config.test.ts`
- Create: `packages/cli/tests/output.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing instance and config tests**

Cover HTTPS canonicalisation, loopback HTTP, rejection of credentials/path/query/fragment,
`--instance` precedence, nearest ancestor `.drops.json`, `instance_required`, portable
config shape, and refusal to overwrite. Use temporary directories, not the real home.

```ts
expect(canonicaliseInstance('HTTPS://Drops.Example.com/')).toBe('https://drops.example.com');
expect(() => canonicaliseInstance('https://u:p@drops.example.com')).toThrowErrorMatchingObject({ code: 'instance_invalid' });
expect(await resolveInstance({ cwd: nested, explicit: undefined })).toBe('https://drops.example.com');
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --dir packages/cli test -- tests/instance.test.ts tests/config.test.ts`

Expected: FAIL because the package/modules do not exist.

- [ ] **Step 3: Add the workspace/package skeleton and minimal config implementation**

Use package name `@tavva/drops-cli`, version `0.1.0`, `type: module`, and:

```json
{"bin":{"drops":"dist/index.js"},"engines":{"node":">=22"}}
```

The CLI package depends only on `yazl`; TypeScript, Vitest, `@types/node`, and
`@types/yazl` are dev dependencies. Add root scripts `cli:build`, `cli:test`, and
`cli:typecheck`. `resolveInstance` must implement flag > nearest config > error and
must not introduce a global default or user-level instance registry.

- [ ] **Step 4: Run config tests and verify GREEN**

Run: `pnpm --dir packages/cli test -- tests/instance.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing output and exit-contract tests**

Test exactly one JSON line on stdout, diagnostics only on stderr, the shared error shape,
and exit categories 0/2/3/4/5/6. Include `auth status` unauthenticated as exit 0.

- [ ] **Step 6: Run output tests and verify RED**

Run: `pnpm --dir packages/cli test -- tests/output.test.ts`

Expected: FAIL because output/command dispatch is incomplete.

- [ ] **Step 7: Implement the minimal output layer and `drops init` command**

Use `DropsCliError` with `{ code, message, instance, details, exitCode }`. The top-level
runner catches only at the process boundary, redacts bearer-looking strings, prints one
error object in JSON mode, and sets `process.exitCode`. Add a Node shebang to `src/index.ts`.

- [ ] **Step 8: Verify the package slice**

Run: `pnpm --dir packages/cli test && pnpm --dir packages/cli typecheck && pnpm --dir packages/cli build`

Expected: all exit 0; `packages/cli/dist/index.js` begins with a usable shebang.

- [ ] **Step 9: Commit with the required date**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml packages/cli
GIT_AUTHOR_DATE='2026-07-11T10:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T10:00:00+01:00' git commit -m "feat(cli): add instance-aware command foundation"
```

---

### Task 2: CLI Keychain adapter and API client

**Files:**
- Create: `packages/cli/src/keychain.ts`
- Create: `packages/cli/src/api.ts`
- Create: `packages/cli/tests/keychain.test.ts`
- Create: `packages/cli/tests/api.test.ts`

- [ ] **Step 1: Write failing Keychain tests**

Inject the process runner and assert `get`, `set`, and `delete` use service
`global.drops.cli` plus the exact canonical origin as the account. The password is provided
through stdin to `security add-generic-password ... -w`, never argv. Test not-found versus
permission/tool errors and verify no plaintext fallback.

- [ ] **Step 2: Run Keychain tests and verify RED**

Run: `pnpm --dir packages/cli test -- tests/keychain.test.ts`

Expected: FAIL because `src/keychain.ts` does not exist.

- [ ] **Step 3: Implement `CredentialStore` and `MacOsKeychainStore`**

```ts
export interface CredentialStore {
  get(origin: string): Promise<string | null>;
  set(origin: string, token: string): Promise<void>;
  delete(origin: string): Promise<void>;
}
```

Use `spawn('security', args)` with pipes and bounded stderr capture. Never include token
material in thrown messages.

- [ ] **Step 4: Verify Keychain tests GREEN**

Run: `pnpm --dir packages/cli test -- tests/keychain.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing API-client tests**

Test discovery validation, cross-origin redirect refusal, no automatic redirect with a
bearer header, JSON error parsing, whoami, self-revoke 204/401 handling, token exchange with
the bounded device label, and upload request headers. Inject `fetch` and assert
`redirect: 'manual'`.

- [ ] **Step 6: Run API tests and verify RED**

Run: `pnpm --dir packages/cli test -- tests/api.test.ts`

Expected: FAIL because `DropsApiClient` is missing.

- [ ] **Step 7: Implement the typed v1 API client**

Expose `discover`, `exchangeCode`, `whoami`, `revokeCurrentToken`, and `deployZip`.
`exchangeCode` sends the code, verifier, exact redirect URI, and the caller's already
sanitised `Drops CLI on <hostname>` label. Validate the discovery `service`, `apiVersion`,
and exact `appOrigin`. Convert status/error payloads to stable `DropsCliError` categories
without logging request headers.

- [ ] **Step 8: Verify and commit**

Run: `pnpm --dir packages/cli test && pnpm --dir packages/cli typecheck`

```bash
git add packages/cli
GIT_AUTHOR_DATE='2026-07-11T11:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T11:00:00+01:00' git commit -m "feat(cli): add secure credentials and API client"
```

---

### Task 3: Server CLI auth schema, token service, and bearer middleware

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0006_*.sql`
- Modify: `src/db/migrations/meta/_journal.json`
- Create: `src/db/migrations/meta/0006_snapshot.json`
- Create: `src/services/cliAuth.ts`
- Create: `src/middleware/cliAuth.ts`
- Modify: `src/services/scheduler.ts`
- Create: `tests/integration/cli-auth-service.test.ts`
- Create: `tests/integration/cli-auth-middleware.test.ts`

- [ ] **Step 1: Write failing token-service tests**

Test five-minute hashed code issue/exchange, exact redirect and S256 verifier validation,
atomic single use under concurrent exchange, token prefix/randomness/hash-only storage,
server validation of a non-empty token label capped at 100 characters with control
characters rejected, member+username lookup, viewer/null-username rejection, one-hour
last-used throttling, self/dashboard revocation, and expired/consumed code deletion.

- [ ] **Step 2: Run token-service tests and verify RED**

Run: `pnpm test -- tests/integration/cli-auth-service.test.ts`

Expected: FAIL because schema and service exports do not exist.

- [ ] **Step 3: Add schema and generate migration**

Add `cliAuthorizationCodes` and `cliTokens` exactly as specified, including FK cascades,
unique token hash, and indexes on user/revocation and code expiry. Run:

```bash
pnpm db:generate
```

Inspect the generated migration and snapshot; do not hand-edit metadata.

- [ ] **Step 4: Implement minimal token service and scheduler cleanup**

Use SHA-256 hex hashes for uniformly random codes/tokens. Exchange accepts a validated
display label and must update `consumed_at` with
`WHERE consumed_at IS NULL AND expires_at > now()` and insert the token plus label in one
transaction. Token lookup joins users and updates `last_used_at` only if null or older than
one hour. Add code cleanup to the existing hourly scheduler tick.

- [ ] **Step 5: Verify token-service tests GREEN**

Run: `pnpm test -- tests/integration/cli-auth-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Write failing bearer-middleware tests**

Test missing, malformed, unknown, revoked, viewer, and incomplete-member tokens return a
JSON 401 without redirects; a valid token populates `req.cliToken` and `req.user`; browser
cookies alone do not authenticate.

- [ ] **Step 7: Run middleware tests RED, implement, then verify GREEN**

Run before implementation: `pnpm test -- tests/integration/cli-auth-middleware.test.ts`

Implement `requireCliToken` and Fastify request types, then rerun both CLI-auth integration
files. Expected final result: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db src/services/cliAuth.ts src/services/scheduler.ts src/middleware/cliAuth.ts tests/integration/cli-auth-*.test.ts
GIT_AUTHOR_DATE='2026-07-11T12:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T12:00:00+01:00' git commit -m "feat: add revocable CLI credentials"
```

---

### Task 4: Discovery, browser approval, token exchange, and auth API

**Files:**
- Create: `src/routes/cli/discovery.ts`
- Create: `src/routes/cli/authorize.ts`
- Create: `src/routes/cli/apiAuth.ts`
- Create: `src/views/cliAuthorize.ejs`
- Modify: `src/views/static/style.css`
- Modify: `src/index.ts`
- Create: `tests/unit/cli-authorization.test.ts`
- Create: `tests/integration/cli-auth-routes.test.ts`
- Modify: `tests/unit/views-csp.test.ts`

- [ ] **Step 1: Write failing pure validation tests**

Test an exact `http://127.0.0.1:<ephemeral>/callback` callback, rejecting localhost, IPv6,
credentials, fragments, HTTPS, non-root hostnames, invalid ports, and malformed S256
challenge/state. Test approval and denial callback URL construction.

- [ ] **Step 2: Verify RED, implement validators, verify GREEN**

Run: `pnpm test -- tests/unit/cli-authorization.test.ts`

Expected first run: FAIL for missing exports; final run after minimal helpers: PASS.

- [ ] **Step 3: Write failing route integration tests**

Cover app-host discovery, wrong-host 404, unauthenticated approval redirect through existing
Google login with a safe app-origin `next`, completed-member approval page, CSRF-protected
approve/deny POST, denial callback (`error=access_denied&state=...`), token exchange JSON,
wrong verifier/redirect/replay/invalid-label errors, persistence of the valid label,
whoami, and self-revoke 204 then 401. API mutation routes must use
`config.skipCsrf = true`; browser approval/revoke routes must not.

- [ ] **Step 4: Run route tests and verify RED**

Run: `pnpm test -- tests/integration/cli-auth-routes.test.ts`

Expected: FAIL because routes are not registered.

- [ ] **Step 5: Implement routes and CSP-safe view**

Register all routes inside `onAppHost`. Approval is an EJS form with hidden state,
challenge, redirect URI, and CSRF fields; no inline script/style. Denial redirects to the
validated loopback callback without issuing a code. Define CLI timeout as five minutes and
map denial/timeout to `authorisation_denied` in the client-facing protocol.

- [ ] **Step 6: Verify auth slice**

Run: `pnpm test -- tests/unit/cli-authorization.test.ts tests/integration/cli-auth-routes.test.ts tests/unit/views-csp.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/cli src/views/cliAuthorize.ejs src/views/static/style.css src/index.ts tests/unit/cli-authorization.test.ts tests/integration/cli-auth-routes.test.ts tests/unit/views-csp.test.ts
GIT_AUTHOR_DATE='2026-07-11T13:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T13:00:00+01:00' git commit -m "feat: add browser-authorised CLI login"
```

---

### Task 5: Shared atomic deployment service and CLI upload API

**Files:**
- Create: `src/services/deployments.ts`
- Modify: `src/routes/app/upload.ts`
- Create: `src/routes/cli/deploy.ts`
- Modify: `src/index.ts`
- Create: `tests/integration/deployments.test.ts`
- Create: `tests/integration/cli-deploy-route.test.ts`
- Modify: `tests/integration/upload-endpoint.test.ts`

- [ ] **Step 1: Write failing shared-deployment tests**

Test first create, replacement, concurrent last-commit-wins behavior, old-version GC
scheduling, and DB commit failure preserving the old version while calling `deletePrefix`
for the new prefix. Inject cleanup/scheduling seams where required rather than mocking SQL.

- [ ] **Step 2: Run shared-service tests and verify RED**

Run: `pnpm test -- tests/integration/deployments.test.ts`

Expected: FAIL because `commitDeployment` is missing.

- [ ] **Step 3: Extract and implement the shared service**

Move the existing transaction from `src/routes/app/upload.ts` without changing browser
semantics. Accept `{ ownerId, name, versionId, r2Prefix, result, entryPath }`; return drop id,
old version id, and whether the named drop was created. On transaction failure, attempt
`deletePrefix(r2Prefix)`, log cleanup failure without masking `commit_failed`, and rethrow a
typed deployment error. Schedule old-version GC only after commit.

- [ ] **Step 4: Verify browser regression coverage GREEN**

Run: `pnpm test -- tests/integration/deployments.test.ts tests/integration/upload-endpoint.test.ts tests/integration/upload-entry.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing CLI deploy-route tests**

Build real zip buffers. Test bearer-only auth, valid slug, `application/zip`, required
`Content-Length`, compressed-body limit, UploadError JSON mapping, atomic success response
including server-calculated URL/entry path, wrong-host 404, and CSRF exemption. Assert an
empty/invalid archive never changes an existing version.

- [ ] **Step 6: Run deploy-route tests RED, implement, then verify GREEN**

Run before implementation: `pnpm test -- tests/integration/cli-deploy-route.test.ts`

Implement raw request streaming into existing `uploadZip`, then commit through the shared
service and return status 201 plus the exact v1 result. Register on app host. Rerun the route,
deployment, and browser upload tests; expected final result: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/deployments.ts src/routes/app/upload.ts src/routes/cli/deploy.ts src/index.ts tests/integration/deployments.test.ts tests/integration/cli-deploy-route.test.ts tests/integration/upload-endpoint.test.ts
GIT_AUTHOR_DATE='2026-07-11T14:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T14:00:00+01:00' git commit -m "feat: add authenticated CLI deployment API"
```

---

### Task 6: CLI source packaging and deploy command

**Files:**
- Create: `packages/cli/src/packageSource.ts`
- Create: `packages/cli/src/deploy.ts`
- Create: `packages/cli/src/commands/deploy.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/tests/package-source.test.ts`
- Create: `packages/cli/tests/deploy.test.ts`

- [ ] **Step 1: Write failing packaging tests**

Use temp fixtures to test directory contents at archive root, regular file basename, zip
passthrough, metadata skips matching `upload-ignore.js`, symlink rejection without following,
early 100 MB/1000 file/25 MB checks, exact archive byte size, and cleanup after success,
failure, and injected abort signal. Add a spawned-process test that sends SIGINT and SIGTERM
while a temporary archive exists and asserts the registered shutdown handler removes it
before exit.

- [ ] **Step 2: Run packaging tests and verify RED**

Run: `pnpm --dir packages/cli test -- tests/package-source.test.ts`

Expected: FAIL because packaging does not exist.

- [ ] **Step 3: Implement minimal packaging**

Use `lstat`/directory walk, sort paths for deterministic tests, and `yazl` to a temp file.
Reject every symlink. Do not read `.gitignore` or create `.dropsignore`. Return an object with
`path`, `byteSize`, and idempotent async `cleanup()`.

Keep active cleanup callbacks in a small process-lifecycle registry owned by `src/index.ts`.
SIGINT/SIGTERM await registered cleanups, then exit with the conventional signal code; tests
inject or spawn the boundary rather than installing global handlers when importing modules.

- [ ] **Step 4: Verify packaging GREEN**

Run: `pnpm --dir packages/cli test -- tests/package-source.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing deploy-command tests**

Test mandatory `--name`, instance resolution, missing credential instruction, discovery,
upload progress on stderr, `Content-Length`, exact successful human/JSON output, API error
mapping, cleanup in all paths, and explicit instance override.

- [ ] **Step 6: Run deploy tests RED, implement, then verify GREEN**

Run before implementation: `pnpm --dir packages/cli test -- tests/deploy.test.ts`

Implement the command with injected API/store/output seams, wire it into `src/index.ts`, and
rerun all CLI tests. Expected final result: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
GIT_AUTHOR_DATE='2026-07-11T15:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T15:00:00+01:00' git commit -m "feat(cli): package and deploy local artifacts"
```

---

### Task 7: CLI browser login, logout, and status orchestration

**Files:**
- Create: `packages/cli/src/auth.ts`
- Create: `packages/cli/src/commands/login.ts`
- Create: `packages/cli/src/commands/logout.ts`
- Create: `packages/cli/src/commands/authStatus.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/tests/auth.test.ts`
- Create: `packages/cli/tests/commands-auth.test.ts`

- [ ] **Step 1: Write failing PKCE/loopback tests**

Test S256 derivation, random state, bind to `127.0.0.1` ephemeral port, exact callback path,
state mismatch, denial, five-minute timeout, browser-open failure, listener closure, and
device-label creation as `Drops CLI on <os.hostname()>` after stripping control characters
and capping the full label at 100 characters. Inject hostname, opener, and a short fake
timeout; do not open a real browser.

- [ ] **Step 2: Run auth tests RED, implement, then verify GREEN**

Run before implementation: `pnpm --dir packages/cli test -- tests/auth.test.ts`

Implement the PKCE and loopback primitives, then rerun. Expected final result: PASS.

- [ ] **Step 3: Write failing command lifecycle tests**

Test login discovery/approval/exchange/store including transport of the sanitised device
label; existing-token re-login revoke-first; 401 old token cleanup; network failure retains
old token and stops; Keychain write failure attempts new-token revoke; logout
revoke-before-delete; logout network failure retains token; status with missing, valid, and
server-invalid credentials; and all exact JSON shapes/exit codes.

- [ ] **Step 4: Run command tests RED, implement, then verify GREEN**

Run before implementation: `pnpm --dir packages/cli test -- tests/commands-auth.test.ts`

Implement the three thin commands and wire parser syntax exactly:

```text
drops login <origin> [--json]
drops logout [origin] [--instance origin] [--json]
drops auth status [origin] [--instance origin] [--json]
```

Rerun auth, API, Keychain, output, and command tests. Expected: PASS.

- [ ] **Step 5: Build and smoke-test the executable help**

Run:

```bash
pnpm --dir packages/cli build
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js auth status --instance http://127.0.0.1:3000 --json
```

Expected: help exits 0; status emits one valid JSON object without leaking diagnostics to
stdout (it may report unauthenticated because no test credential is installed).

- [ ] **Step 6: Commit**

```bash
git add packages/cli
GIT_AUTHOR_DATE='2026-07-11T16:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T16:00:00+01:00' git commit -m "feat(cli): add persistent browser login"
```

---

### Task 8: Dashboard revocation, cleanup, docs, and full-system tests

**Files:**
- Create: `src/routes/app/cliTokens.ts`
- Modify: `src/routes/app/dashboardView.ts`
- Modify: `src/views/dashboard.ejs`
- Modify: `src/views/static/style.css`
- Modify: `src/index.ts`
- Create: `tests/integration/cli-token-dashboard.test.ts`
- Create: `tests/e2e/cli.spec.ts`
- Create: `tests/e2e/helpers/bin/security`
- Create: `tests/e2e/helpers/bin/open`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `package.json`

- [ ] **Step 1: Write failing dashboard tests**

Test owner-only token listing with label/created/last-used, escaped labels, CSRF-protected
revocation, token ownership checks, already-revoked handling, no bearer values in HTML/logs,
and CSP compliance.

- [ ] **Step 2: Run dashboard tests RED, implement, then verify GREEN**

Run before implementation: `pnpm test -- tests/integration/cli-token-dashboard.test.ts tests/unit/views-csp.test.ts`

Add the route, dashboard data, accessible markup, and existing-style CSS. Register on app
host. Rerun; expected final result: PASS.

- [ ] **Step 3: Write and run the end-to-end CLI test RED**

The Playwright test uses a real built CLI process, local Fastify instance, and real
Postgres/MinIO without touching the user's Keychain or launching their browser. Prepend a
fixture `bin` directory to the child process `PATH`: its executable `security` shim implements
the exact find/add/delete calls against a per-test file named by
`DROPS_CLI_TEST_KEYCHAIN_FILE`, and its executable `open` shim writes the requested URL to
`DROPS_CLI_TEST_OPEN_FILE`. These environment variables are consumed only by the fixture
programs, never by production CLI code. Playwright reads the captured authorisation URL,
navigates an already-authenticated test browser through approval, and lets the real loopback
callback complete the waiting CLI process.

Cover full browser login then deploy, two separately configured local server instances whose
discovery documents return their respective exact app origins, independent fake-Keychain
entries for those origins, repository default versus flag override, real zip upload/serve,
JSON stdout parsing, and dashboard revocation causing the next CLI request to return
`not_authenticated`.

Run: `pnpm test:e2e -- cli.spec.ts`

Expected first run: FAIL until the fixture executables and local server orchestration are
completed; final run: PASS.

- [ ] **Step 4: Document installation and agent usage**

Document the package and command:

```bash
pnpm add --global @tavva/drops-cli
drops login https://drops.example.com
drops init --instance https://drops.example.com
drops deploy ./dist --name preview --json
```

Explain macOS-only Keychain storage, multiple independent instance credentials, explicit
names, committed `.drops.json`, logout/revocation, and no secrets in repo config. Add CLI
test/build commands to `AGENTS.md` without adding maintainer-specific deployment data.

- [ ] **Step 5: Run complete verification**

Run, in order:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
pnpm --dir packages/cli test
pnpm --dir packages/cli typecheck
pnpm --dir packages/cli build
```

Expected: every command exits 0 with no failing tests or lint/type errors.

- [ ] **Step 6: Audit requirements and secrets**

Run:

```bash
rg -n "drops_cli_[A-Za-z0-9_-]{10,}|R2_SECRET|GOOGLE_CLIENT_SECRET|project ID|service ID" packages/cli src tests README.md AGENTS.md
git diff --check origin/main...HEAD
git status --short
git log --format='%h %aI %cI %s' origin/main..HEAD
```

Expected: no committed token/secret values; clean diff check; only intentional files; every
feature commit has both dates on 2026-07-11.

- [ ] **Step 7: Commit final integration**

```bash
git add src/routes/app/cliTokens.ts src/routes/app/dashboardView.ts src/views/dashboard.ejs src/views/static/style.css src/index.ts tests/integration/cli-token-dashboard.test.ts tests/e2e/cli.spec.ts tests/e2e/helpers/bin README.md AGENTS.md package.json
GIT_AUTHOR_DATE='2026-07-11T17:00:00+01:00' GIT_COMMITTER_DATE='2026-07-11T17:00:00+01:00' git commit -m "feat: finish agent CLI workflow"
```

- [ ] **Step 8: Re-run verification after the final commit**

Repeat the complete verification commands from Step 5 and the commit-date audit from Step 6.
Do not claim completion from the pre-commit run.
