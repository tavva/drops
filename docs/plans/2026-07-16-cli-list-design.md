# CLI list command — design

`drops list` shows the authenticated user's own drops. `drops list <name>` shows
the file listing for one drop. Both follow the existing CLI output and error
contracts.

## Server API

Two bearer-authenticated endpoints on the app host, wired in `src/index.ts`
alongside the existing CLI routes, using `requireCliToken` and the same
rate-limit pattern as the deploy route:

- `GET /api/v1/drops` — returns the caller's own drops via `listByOwner`:
  `{ instance, drops: [{ name, url, updatedAt, byteSize, fileCount, entryPath,
  versionId }] }`. `url` is built with `dropOriginFor`, matching the deploy
  response shape. Drops with no current version report `byteSize: 0`,
  `fileCount: 0`, `entryPath: null`, `versionId: null`.
- `GET /api/v1/drops/:name/files` — validates the slug, looks up the drop with
  `findByOwnerAndName` (owner-scoped), and returns
  `{ instance, name, files: [{ path, size }] }`. Unknown drop → structured 404.
  A drop with no current version returns an empty file list.

File sizes come from R2. `listPrefix` in `src/lib/r2.ts` returns keys only, so
add a listing that returns `{ key, size }` from `ListObjectsV2` and reimplement
`listPrefix` on top of it; existing callers are untouched.

Errors follow the structured `{ error: { code, message, details } }` contract
so the CLI client's parsing and redaction work unchanged.

## CLI command

`drops list [name]` in `packages/cli/src/commands/list.ts`, dispatched from
`index.ts` like the other commands.

- Accepts an optional positional `name` plus `--instance` and `--json`.
  Instance and credential resolution reuse the `auth status`/`deploy` path
  (repository `.drops.json` or `--instance`, token from the credential store).
  No token → the existing `not_authenticated` error.
- Two new `DropsApiClient` methods, `listDrops(origin, token)` and
  `listDropFiles(origin, token, name)`, built on `bearerRequest`/
  `throwForResponse` with type-guard response validation.
- Bare `drops list` prints one line per drop: name, URL, file count,
  human-readable size, updated date. Empty state: `No drops on <instance>`.
- `drops list <name>` prints one line per file: size then path. Unknown drop
  surfaces the server's structured 404 (exit code 4).
- `--json` uses the existing output envelope. `help.ts` gains the `list`
  entries (root help, command help, agent guidance).

## Testing

TDD throughout.

- Server integration tests: auth required, owner scoping, unknown drop 404,
  drop with no current version, file sizes returned.
- CLI unit tests with injected fetch: argument parsing, human and JSON output,
  error mapping.
- Help-contract tests updated for the new command.
- The e2e injected journey extended to run `list` after `deploy`.
