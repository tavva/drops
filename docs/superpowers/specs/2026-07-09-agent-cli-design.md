# Drops Agent CLI Design

**Date:** 2026-07-09
**Status:** Approved for implementation planning

## Summary

Drops will gain a command-line client so local coding agents can publish static
artifacts without driving the browser UI. A human authorises the CLI through
the existing Google-authenticated Drops app, after which the CLI keeps a
revocable credential in macOS Keychain.

The CLI supports multiple independent Drops instances from day one. A
repository can commit its intended instance in `.drops.json`, while every
deployment still requires an explicit drop name. CLI uploads use a new API
route that delegates to the same validated, atomic deployment path as browser
uploads.

## Goals

- Let a local coding agent publish a file, directory, or zip with one command.
- Require a human Drops user to authorise the CLI in a browser first.
- Persist each authorised instance credential in macOS Keychain until logout
  or revocation.
- Treat every Drops instance as an independent trust and credential boundary.
- Let a repository commit its default Drops instance without committing a
  secret.
- Require an explicit drop name for every deployment.
- Preserve the existing upload limits, path hardening, atomic version switch,
  entry-page detection, and garbage collection behaviour.
- Provide stable structured output and errors suitable for coding agents.

## Non-goals

- CI, headless servers, remote agents, service accounts, or unattended login.
- Linux or Windows credential storage.
- Direct R2 or Postgres access from the CLI.
- Token access to viewer management, permissions, deletion, or other dashboard
  operations.
- Global default instances or implicit drop-name inference.
- Version history, rollback, or deployment deduplication.
- Custom ignore files or a general-purpose sync protocol.

## User Experience

### Authorise an instance

```bash
drops login https://drops.example.com
```

The CLI verifies that the origin is a compatible Drops instance, starts a
temporary loopback listener, and opens the instance's authorisation page. The
user signs in with Google if necessary and explicitly approves CLI access.
After the browser returns to the loopback listener, the CLI exchanges the
single-use code and stores the resulting token in macOS Keychain.

An existing browser session can satisfy the Google sign-in step, but the CLI
approval is always explicit.

### Pin a repository to an instance

```bash
drops init --instance https://drops.example.com
```

This writes:

```json
{
  "instance": "https://drops.example.com"
}
```

The file is intentionally safe to commit. It never contains user identity or
credentials. `drops init` refuses to replace an existing `.drops.json` unless
the user explicitly requests an overwrite.

### Deploy

```bash
drops deploy ./dist --name sample-site
```

The CLI packages the selected path, uploads it to the resolved instance, and
prints progress followed by the live URL. The drop name is mandatory; the CLI
never derives it from a repository or directory name.

For automation:

```bash
drops deploy ./dist --name sample-site --json
```

In JSON mode, stdout contains exactly one JSON result object. Progress and
diagnostics go to stderr.

An explicit instance overrides the repository setting:

```bash
drops deploy ./dist --name sample-site \
  --instance https://drops.example.net
```

### Inspect or remove authorisation

```bash
drops auth status
drops auth status https://drops.example.net
drops logout https://drops.example.com
```

With no origin argument, `auth status` resolves the instance using the same
rules as `deploy`. Logout first revokes the current token at that exact instance,
then removes its Keychain item. It does not affect any other instance.

## Instance Resolution

The CLI resolves an instance in this order:

1. The `--instance` command-line option.
2. The nearest `.drops.json`, searching from the current working directory up
   through its ancestors.
3. Stop with a stable `instance_required` error and instructions for `drops
   init` or `--instance`.

There is no implicit global default, even when only one instance is authorised.
This avoids publishing an agent's output to the wrong organisation.

Origins are canonicalised before config or Keychain lookup. A production
origin must:

- use HTTPS;
- contain no username, password, query, fragment, or non-root path;
- be reduced to its lowercase host, explicit non-default port if present, and
  no trailing slash.

Plain HTTP is accepted only for a loopback host in local development. The CLI
does not forward instance discovery or authenticated API requests across an
origin-changing redirect.

Local aliases and a user-level instance registry are not part of the v1 command
contract. The canonical origin is the portable instance identifier, and
Keychain is the only machine-level state.

## Browser Authorisation Flow

### Discovery

Every compatible app origin exposes:

```http
GET /.well-known/drops
```

The unauthenticated response identifies the service and supported API version:

```json
{
  "service": "drops",
  "apiVersion": 1,
  "appOrigin": "https://drops.example.com"
}
```

The CLI requires `service = "drops"`, support for API version 1, and an
`appOrigin` equal to the canonical origin it contacted. Discovery redirects
may not cross origins.

### PKCE and loopback callback

1. The CLI creates a high-entropy state, a PKCE verifier, and its S256
   challenge.
2. It binds an HTTP listener to an ephemeral port on `127.0.0.1` only.
3. It prints the full authorisation URL to stderr so the user can copy and
   paste it, then opens the instance's `GET /app/cli/authorize` with the
   loopback redirect URI, state, challenge, and `code_challenge_method=S256`.
4. The app requires a completed member session. An unauthenticated user goes
   through the existing Google login flow and returns to the authorisation
   page.
5. The page identifies the requesting Drops CLI and asks the user to allow it
   to read their identity and create or update their own drops.
6. Approval is a session-authenticated, CSRF-protected POST. The server creates
   a random, short-lived authorisation code and stores only its hash, bound to
   the user, PKCE challenge, and exact loopback redirect URI.
7. The browser redirects to the loopback URI with `code` and the original
   state. The CLI rejects a state mismatch.
8. The CLI sends the code, verifier, and redirect URI to `POST
   /api/v1/auth/token`.
9. The server atomically consumes the unexpired code, verifies the exact
   redirect URI and PKCE challenge, and returns a newly generated opaque CLI
   token. A code can succeed only once.
10. The CLI stores the token in Keychain and closes the loopback listener.

The token exchange is not browser-session authenticated and is exempt from
browser CSRF handling; possession of the one-time code plus its PKCE verifier
is the credential for that exchange.

The authorisation endpoint accepts callback hosts only when the parsed hostname
is exactly `127.0.0.1` and the scheme is HTTP. It rejects credentials, fragments,
non-loopback host spellings, and malformed ports. It never accepts an arbitrary
web callback.

### Persistent CLI tokens

CLI tokens contain a recognisable `drops_cli_` prefix followed by at least 256
bits of cryptographically random material. The full token is returned exactly
once. Drops stores a SHA-256 hash, which is sufficient for a uniformly random
token, rather than the bearer value.

Each token belongs to one member user within one deployed Drops instance. The
CLI API middleware accepts it only from an `Authorization: Bearer` header.
Browser session cookies do not authenticate CLI API routes, and CLI tokens do
not authenticate browser routes.

There is one fixed v1 capability set: read the authenticated identity and
create or update drops owned by that identity. Keeping this as a separate route
surface avoids introducing a general scope system before more token use cases
exist.

Tokens remain valid until logout, explicit dashboard revocation, deletion of
their user, or demotion of their user from a completed member account. A
completed member has `kind = 'member'` and a non-null username, matching the
existing app upload requirement. No new disabled-user state is introduced.

The authenticated endpoint `DELETE /api/v1/auth/token` revokes the exact bearer
token used for the request. `drops logout <origin>` calls it before deleting the
Keychain item. If the server returns success or 401 because the token is already
invalid, the CLI deletes the item. If the instance cannot be reached or returns
an unexpected error, the CLI retains the Keychain item, returns a failure, and
instructs the user to retry or revoke it from the dashboard. It never reports a
successful logout while a usable server token may remain.

Running `drops login <origin>` when a credential already exists applies that
same revocation sequence before starting a new browser flow. A failure to revoke
the old usable token stops login rather than overwriting the only local copy. If
the new token is issued but Keychain storage fails, the CLI immediately attempts
to revoke the new token and reports that the dashboard is the fallback if that
cleanup also fails.

The dashboard lists each CLI authorisation with its label, creation time, and
last-used time and provides a CSRF-protected revoke action.

### Credential storage

The v1 CLI supports macOS Keychain only. Each generic-password item uses a
constant Drops CLI service name and the canonical instance origin as its
account key, so credentials for separate instances cannot overwrite or select
one another.

The Keychain integration sits behind a small credential-store interface. The
token must not appear in process arguments, logs, config files, environment
variables, or shell history. If Keychain is unavailable or denies access, the
operation fails; there is no plaintext fallback.

The CLI supplies the bounded label `Drops CLI on <hostname>`, where hostname is
the local macOS hostname stripped of control characters and the complete label
is capped at 100 characters. There is no label flag in v1.

## CLI Upload API

The authenticated deployment endpoint is:

```http
POST /api/v1/drops/:name/deployments
Authorization: Bearer <cli-token>
Content-Type: application/zip
Content-Length: <compressed-size>
```

The body is a zip stream rather than browser multipart data. The server applies
an explicit compressed-body limit before or while spooling, then delegates to
the existing zip upload validation.

The route validates the drop slug and always uses the token's user as owner. A
client cannot submit another owner identifier. Because drop names are unique
per owner, the route creates the named drop on first use and atomically replaces
that same user's existing drop on later use.

Every API response, including errors, is JSON. A successful response is:

```json
{
  "instance": "https://drops.example.com",
  "name": "sample-site",
  "url": "https://alice--sample-site.content.drops.example.com",
  "versionId": "0bf87d5f-f16d-421d-a8d2-322e832e9ab1",
  "fileCount": 42,
  "byteSize": 1834201,
  "entryPath": "index.html"
}
```

`entryPath` is nullable when no unambiguous entry page was detected. The
response URL is calculated by the instance, not reconstructed from app-origin
conventions in the CLI.

The identity check used by `drops auth status` is:

```http
GET /api/v1/whoami
Authorization: Bearer <cli-token>
```

It returns the member's id, email, and username for that instance.

The self-revocation request used by logout is:

```http
DELETE /api/v1/auth/token
Authorization: Bearer <cli-token>
```

It atomically sets `revoked_at` on the token identified by the bearer value and
returns 204. Repeating the operation with an already revoked token returns 401,
which the CLI treats as confirmation that the stored credential is no longer
usable.

## Shared Deployment Service

The existing browser upload route currently owns both transport parsing and the
database version swap. That commit logic will move into a transport-independent
deployment service.

The boundary is:

```text
browser multipart route ----> validated UploadResult --+
                                                     +--> commit deployment
CLI zip API route -----------> validated UploadResult --+    and schedule GC
```

The shared service receives the authenticated owner, explicit drop name,
allocated version id and R2 prefix, validated upload result, and detected entry
path. It performs the current insert-or-select plus `FOR UPDATE` transaction,
switches `current_version`, and schedules old-version garbage collection after
commit. If that database transaction fails after the completed upload, the
shared service immediately attempts to delete the new R2 prefix before
propagating the commit error. Best-effort cleanup failure is logged with the
prefix; it does not change the API error. This is the same immediate cleanup
behaviour the browser path will gain through the extraction.

Transport routes remain responsible for authentication, request parsing, and
mapping errors to browser redirects or API JSON. Upload services own cleanup of
partial R2 writes caused during parsing, validation, or streaming. The shared
deployment service owns cleanup after an upload has completed but its database
commit fails. This preserves the existing atomicity guarantee without
duplicating security-critical logic.

## Local Packaging

`drops deploy` accepts a regular file, directory, or zip:

- A directory is archived with its contents at the zip root, not inside an
  extra directory named after the source.
- A regular non-zip file is archived at the root using its basename.
- A zip is uploaded as supplied after local size checks; the server remains the
  security boundary and performs full archive validation.
- Symlinks encountered while walking a file or directory cause a local error.
  They are never followed.
- The CLI skips the same known OS metadata files already ignored by browser
  uploads. Other paths are left for the server's canonical path validation.
- The CLI performs early file-count and byte-size checks for fast feedback, but
  the server rechecks declared and streamed bytes.

The CLI sends an exact `Content-Length` for the completed temporary archive so
it can show upload progress and the server can reject an oversized compressed
body promptly. Temporary archives are removed on success, failure, and process
signals handled by the CLI.

The v1 deliberately does not interpret `.gitignore` or add `.dropsignore`.
Users and agents should pass the intended build output path rather than the
repository root.

## Output and Errors

Human output uses stderr for progress and prints the final live URL clearly.
Every v1 command (`login`, `logout`, `init`, `auth status`, and `deploy`) accepts
`--json`. In JSON mode, stdout is reserved for exactly one JSON object followed
by a newline; it never contains progress, browser-login instructions, or
logging noise. Interactive login instructions, including the copyable browser
authorisation URL, and progress remain on stderr.

Successful JSON shapes are command-specific and stable:

```json
{"instance":"https://drops.example.com","user":{"id":"...","email":"user@example.com","username":"alice"}}
{"instance":"https://drops.example.com","revoked":true}
{"path":"/repo/.drops.json","instance":"https://drops.example.com"}
{"instance":"https://drops.example.com","authenticated":true,"user":{"id":"...","email":"user@example.com","username":"alice"}}
{"instance":"https://drops.example.com","authenticated":false,"user":null}
```

These are respectively the `login`, `logout`, `init`, and two `auth status`
results. Deploy uses the successful API response object defined in **CLI Upload
API** without wrapping it. Additive fields may be introduced in later API
versions; existing fields do not change meaning within v1.

All command failures use this JSON shape:

```json
{
  "error": {
    "code": "not_authenticated",
    "message": "Run: drops login https://drops.example.com",
    "instance": "https://drops.example.com",
    "details": null
  }
}
```

`instance` is null when resolution did not reach an origin. `details` is null or
a JSON object containing non-secret machine-readable context. Human and JSON
modes use the same error codes.

Stable CLI error codes include:

- `instance_required`
- `instance_invalid`
- `instance_incompatible`
- `not_authenticated`
- `authorisation_denied`
- `keychain_unavailable`
- `source_not_found`
- `source_symlink`
- `invalid_name`
- the existing upload error codes such as `file_count`, `total_size`,
  `path_rejected`, `invalid_zip`, and `zip_bomb`
- `network_error`
- `server_error`

An HTTP 401 maps to `not_authenticated` and names the exact `drops login
<origin>` command required. Secrets are redacted from thrown errors, request
logs, debug output, and JSON errors.

Process exit codes are stable by category:

- `0`: success; unauthenticated `auth status` is also a successful query and
  returns `authenticated: false`.
- `2`: command usage, local input, source, name, or instance configuration
  error.
- `3`: authentication, authorisation denial, logout revocation failure, or
  Keychain error.
- `4`: the server rejected upload content or limits.
- `5`: network failure or incompatible/unavailable instance.
- `6`: unexpected server or CLI internal error.

The specific JSON error code is the primary automation contract; the numeric
exit code provides a coarse shell-level category.

If upload validation, R2 writing, or the database commit fails, the currently
served version remains unchanged. A response can be lost after a successful
commit; retrying may create another version internally, but the visible result
is still the requested content and old versions remain eligible for garbage
collection. No idempotency-key system is required for v1.

## Data Model

Two tables are added.

### `cli_authorization_codes`

- `code_hash` text primary key
- `user_id` UUID foreign key to `users`, cascade on delete
- `redirect_uri` text, exact loopback URI used at authorisation
- `code_challenge` text
- `created_at` timestamptz
- `expires_at` timestamptz
- `consumed_at` nullable timestamptz

Codes expire after five minutes. Exchange consumes a matching live code in the
same transaction that creates its CLI token. Expired and consumed rows can be
removed by the existing scheduled maintenance mechanism.

### `cli_tokens`

- `id` UUID primary key
- `user_id` UUID foreign key to `users`, cascade on delete
- `token_hash` text unique, never the bearer value
- `label` text, a bounded display label supplied by the CLI
- `created_at` timestamptz
- `last_used_at` nullable timestamptz
- `revoked_at` nullable timestamptz

Token lookup requires `revoked_at IS NULL`, `users.kind = 'member'`, and a
non-null username. `last_used_at` updates when it is null or more than one hour
old, avoiding a database write on every request while giving the dashboard a
defined accuracy bound.

## Code Organisation

The CLI will be a small Node 22 package under `packages/cli`, with its own
runtime dependencies and executable entry point. The repository will become a
pnpm workspace while the existing server package remains at the root. This
avoids making CLI users install the server's Fastify, database, and AWS runtime
dependencies.

The server additions remain separated by responsibility:

- CLI discovery and browser authorisation routes.
- CLI token exchange and bearer-authenticated API routes.
- API-token authentication middleware and token services.
- The shared deployment commit service extracted from the browser route.
- Dashboard presentation and revocation for CLI authorisations.

Every server route is registered on the app host only. No CLI or token endpoint
is exposed on the content apex or per-drop content hosts.

## Testing

### CLI unit tests

- Origin canonicalisation and rejection of unsafe origins.
- Instance precedence: flag, nearest repo config, then required-instance error.
- `.drops.json` creation and safe refusal to overwrite.
- Keychain entries keyed by exact canonical origin, using a mocked credential
  store in tests.
- Logout and re-login revocation ordering, 401 handling, network-failure
  retention, and Keychain-write cleanup.
- PKCE/state generation and callback validation.
- File, directory, and zip packaging; root layout; metadata skips; symlink
  rejection; early limits; and temporary-file cleanup.
- Exact per-command JSON success/error schemas, stdout/stderr isolation, and
  secret redaction.
- Auth, input, upload, network, and internal error-to-exit-code mapping.

### Server unit and integration tests

- Discovery metadata and host routing.
- Loopback redirect validation, member-only approval, and approval CSRF.
- PKCE mismatch, redirect mismatch, expiry, atomic single use, and replay.
- Token hashing, bearer parsing, self/dashboard revocation, deleted or demoted
  users, and one-hour last-used tracking.
- Browser cookies rejected by CLI routes and CLI tokens rejected by browser
  routes.
- Upload slug validation, token-user ownership, limits, structured errors, and
  successful response URLs.
- Browser and CLI transports exercising the same shared atomic commit service.
- Failed upload and failed commit preserving the current version, with cleanup
  performed by the upload service and shared deployment service respectively.

### End-to-end tests

- Complete local browser authorisation followed by a CLI deployment.
- Two local instance origins with independent credentials and correct
  repository/flag resolution.
- Dashboard revocation causing the next CLI request to fail with
  `not_authenticated`.
- JSON-mode deployment producing parseable stdout and diagnostics only on
  stderr.

## Rollout

The feature can ship in one code release because old browser behaviour remains
compatible. Database migrations create the new tables before the server starts.
Instances without any authorised CLI tokens behave exactly as before.

After deploying an instance, a user installs the CLI package, runs `drops login
<origin>`, commits `.drops.json` via `drops init`, and can then instruct local
agents to run an explicit `drops deploy <path> --name <name>` command.
