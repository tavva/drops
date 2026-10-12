# CLI read commands — design

`drops cat` prints one file from a drop. `drops pull` downloads a whole drop to
a local directory. `drops list --all` finds drops shared with you. All three
read any drop the caller can view in the browser, not just their own.

## Addressing

A drop reference is either `name` (the caller's own drop) or `owner/name`
(any user's drop; the same order as the `owner--name` subdomain). The CLI
resolves a bare `name` to the caller's username with one `GET /api/v1/whoami`
call, so the new server routes only accept the `owner/name` form. Both parts
must be valid slugs/usernames; the CLI rejects anything else before any network
call.

## Server API

All read routes live in `src/routes/cli/read.ts` (renamed from `list.ts`),
using `requireCliToken`, the existing rate-limit pattern and the structured
`{ error: { code, message, details } }` contract. Only completed members can
hold CLI tokens; `canView` is still the final check on every read.

- `GET /api/v1/drops` — unchanged default (`scope=mine`). `?scope=all` returns
  every drop the caller can view, from `listAllVisibleUnpaged`. Every entry
  gains `owner` (username) in both scopes, and `url` is built from the owner's
  username. An unknown `scope` value → 400 `invalid_scope`.
- `GET /api/v1/drops/:name/files` — unchanged; the shipped CLI calls it.
- `GET /api/v1/drops/:owner/:name/files` — looks up the owner by username, the
  drop by owner and name, then `canView(request.user, drop)`. Unknown owner,
  unknown drop and refused permission all return the same 404
  `drop_not_found`, so a token cannot probe for private drops. The response
  matches the existing files route plus `owner` and `versionId` (null and an
  empty list when the drop has no current version).
- `GET /api/v1/drops/:owner/:name/content/*` — same lookup and `canView`, then
  the path goes through `src/lib/path.ts` normalisation (traversal, absolute
  roots, control characters rejected → 400 `invalid_path`). Streams the R2
  object for the current version with `Content-Type`, `Content-Length` and
  `X-Drops-Version: <versionId>`. Missing file → 404 `file_not_found`; drop
  with no current version → 404 `file_not_found`. No index fallback: paths
  are exact, as listed by `files`.
  Optional `?version=<id>`: if it is not the current version → 409
  `version_changed`.

## CLI commands

- `drops list --all` — adds an `OWNER/NAME` column (human) and `owner` in
  JSON for each drop. `drops list <ref>` accepts `owner/name` too, using the
  owner route; a bare name keeps calling the existing own-drop route.
- `drops cat <ref> <path> [--instance <origin>]` — streams the file's raw bytes
  to stdout and nothing else. `--json` is not accepted (rejected as an unknown
  option with the usual usage error), since stdout carries file bytes. Errors
  go to stderr with the existing error contract and exit codes (404 → 4).
- `drops pull <ref> [dir] [--instance <origin>] [--json]` — `dir` defaults to
  `./<name>`. Refuses if `dir` exists and is not an empty directory. Fetches
  the file list, then each file with `?version=<versionId>`, writing into a
  temporary sibling directory that is renamed onto `dir` only when every file
  has arrived. On `version_changed` it discards the temporary directory and
  restarts once; a second change is an error. Any failure removes the
  temporary directory. Each path from the server is re-validated locally
  (no absolute paths, no `..`, no empty segments) before writing, so a hostile
  or buggy server cannot write outside `dir`. Files download one at a time.
  JSON result: `{ instance, owner, name, versionId, directory, fileCount,
  byteSize }`. Human output: one summary line.
- `help.ts` gains `cat` and `pull` entries and the `--all` option on `list`,
  with notes that only drops you can view in the browser are readable.
  READMEs (root and `packages/cli`) document the new commands.

## Testing

TDD throughout.

- Server integration: auth required; own, `public`, `authed`, `emails` (listed
  viewer, include-domain) drops readable; refused, unknown owner and unknown
  drop give identical 404s; traversal and bad paths → 400; missing file 404;
  `version` mismatch 409; content bytes and headers; `scope=all` contents and
  `owner` field; existing `/api/v1/drops/:name/files` behaviour unchanged.
- CLI unit tests with injected fetch: reference parsing, whoami resolution,
  `cat` writes exact bytes, `pull` refuses non-empty dirs, rejects hostile
  paths, restarts once on 409, cleans up on failure, JSON and human output.
- Help-contract tests updated.
- The e2e injected journey runs `list --all`, `cat` and `pull` after `deploy`.
