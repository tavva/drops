# CLI read commands — design

`drops pull` downloads a whole drop to a local directory. `drops list --all`
finds drops shared with you, and `drops list owner/name` lists another owner's
files. Both read any drop the caller can view in the browser, not just their
own. Printing one file is already covered by `drops view`, so there is no
separate `cat` command.

## Addressing

A drop reference is either `name` (the caller's own drop) or `owner/name`
(any user's drop; the same order as the `owner--name` subdomain), matching
`drops view` and `drops open`. `pull` resolves a bare `name` to the caller's
username with one `GET /api/v1/whoami` call. Both parts must be valid
slugs/usernames; the CLI rejects anything else before any network call
(`invalid_name` for a bad bare name, `invalid_reference` otherwise).

## Server API

The list routes live in `src/routes/cli/read.ts` (renamed from `list.ts`);
content reads use the existing `drops view` route in `src/routes/cli/view.ts`.
All use `requireCliToken` and the structured
`{ error: { code, message, details } }` contract. Only completed members can
hold CLI tokens; `canView` is the final check on every read.

- `GET /api/v1/drops` — unchanged default (`scope=mine`). `?scope=all` returns
  every drop the caller can view: `listAllVisibleUnpaged` filtered through
  `canView`, so a member who has left the allowlist sees only what they can
  still read. Every entry gains `owner` (username) in both scopes, and `url`
  is built from the owner's username. An unknown `scope` → 400
  `invalid_scope`.
- `GET /api/v1/drops/:name/files` — without `owner`, unchanged: the caller's
  own drop, `{ instance, name, files }`. With `?owner=<username>` it looks up
  the owner by username, the drop by owner and name, then applies `canView`.
  Unknown owner, unknown drop and refused permission all return the same 404
  `drop_not_found`, so a token cannot probe for private drops. The response is
  `{ instance, owner, name, versionId, files }` (`versionId: null` and an
  empty list when the drop has no current version).
- `GET /api/v1/drops/:name/content?owner=&path=&version=` — the existing
  `drops view` route. It already applies `canView` with one 404 for every
  refusal, rejects unsafe paths with 400 `invalid_path`, and serves bytes
  inertly (`application/octet-stream`, `Content-Disposition: attachment`,
  `Content-Security-Policy: default-src 'none'; sandbox`) so uploaded HTML
  never runs on the app origin. It gains:
  - `version` (a UUID): if it is not the current version → 409
    `version_changed`. The check runs after the permission check, so a
    refused drop still gets the identical 404. A malformed version fails
    schema validation with 400 `invalid_request`.
  - a per-route rate limit of 2400 requests a minute. Pull reads one file per
    request and a drop may hold up to 1000 files, so the global limit of 120
    would fail any pull of a drop with more than about 119 files; 2400 covers
    a full pull plus its one restart.
  - no automatic HEAD route, which would fetch the whole object to discard it.

  Directory paths fall back to `index.html` as they do for `view`; pull only
  requests the exact paths the files route listed, so the fallback never
  applies to it.

## CLI commands

- `drops list --all` — adds an `owner/name` first column (human) and `owner`
  in JSON for each drop. `drops list <ref>` accepts `owner/name` too, using
  the `?owner=` files route; a bare name keeps calling the own-drop route.
  `--all` with a reference is a usage error.
- `drops pull <ref> [dir] [--instance <origin>] [--json]` — `dir` defaults to
  `./<name>`. Refuses if `dir` exists and is not an empty directory
  (`directory_not_empty`). Fetches the file list, then each file with
  `?version=<versionId>`, one at a time, writing into a hidden staging
  directory beside `dir` that is renamed onto `dir` only when every file has
  arrived. On `version_changed` it discards the staging directory and
  restarts once; a second change is an error. Any failure, or an interrupt,
  removes the staging directory. Each path from the server is re-validated
  locally (no absolute paths, backslashes, control characters, or empty or
  dot-prefixed segments) before writing, so a hostile or buggy server cannot
  write outside `dir` (`unsafe_path`). Two paths that map to one local entry
  report `path_conflict`; other local filesystem failures report
  `write_failed` with the path and errno. JSON result: `{ instance, owner,
  name, versionId, directory, fileCount, byteSize }`. Human output: one
  summary line.
- Credentials come from `createCredentialStore()` (macOS Keychain or Linux
  credential files), shared with `view` through `authenticatedInstance`.
- `help.ts` gains the `pull` entry and `--all` / `owner/name` on `list`, with
  notes that only drops you can view in the browser are readable. READMEs
  (root and `packages/cli`) document the new commands.

## Testing

TDD throughout.

- Server integration: auth required; own, `public`, `authed`, `emails`
  (listed viewer, include-domain) drops listed and readable; refused, unknown
  owner and unknown drop give identical 404s, including with a wrong
  `version`; `version` mismatch 409; malformed `version` 400; content reads
  above the global limit; no HEAD; `scope=all` contents, `owner` field and the
  `canView` filter; `/api/v1/drops/:name/files` without `owner` unchanged.
- CLI unit tests with injected fetch and real temporary directories:
  reference parsing, whoami resolution, `pull` refuses non-empty
  directories, rejects hostile paths, restarts once on 409, cleans up on
  failure, reports local write failures, JSON and human output.
- Help-contract tests updated.
- The e2e injected journey runs `list --all`, `list owner/name` and `pull`
  (own and shared, then refused) after `deploy`.
