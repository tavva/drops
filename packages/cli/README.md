# @tavva/drops-cli

The command-line client for publishing local files, folders, and zip archives to a Drops instance.

## Install

```bash
pnpm add --global @tavva/drops-cli
```

To link the CLI directly from a Drops source checkout while developing it, run
this from the repository root:

```bash
pnpm cli:build
pnpm --dir packages/cli exec pnpm link --global
```

Do not use `pnpm --dir packages/cli link --global`: pnpm links the workspace
root package for that command instead of the CLI package.

The CLI requires Node.js 22 or newer and currently supports macOS credential storage. Browser-approved bearer credentials are stored in macOS Keychain, keyed by the instance's exact origin.

`drops login` prints its complete authorisation URL before trying to open the
browser, so you can copy and paste the URL if no window appears.

## Use

Discover the full workflow from the installed tool:

```bash
drops --help
drops deploy --help
drops help --json
```

`drops help --json` is the agent-facing discovery surface. It returns a
versioned catalogue containing every command's summary, usage, arguments,
options, examples, and notes. Actionable errors also expose `usage`, `hint`,
and `examples` fields in JSON mode.

```bash
drops login https://drops.example.com
drops init --instance https://drops.example.com
drops deploy ./dist --name preview --json
drops list
drops list preview
drops auth status --json
drops logout
```

`drops list` shows the drops you own on the selected instance; add a drop name to list that drop's files with sizes.

Commit the generated `.drops.json` if you want the repository to share its default instance. It contains only the instance origin, never credentials. Each deploy requires an explicit `--name`; use `--instance` to override the repository default when working with another independently authenticated instance.

`drops logout` revokes the local authorisation. You can also revoke active CLI access from the Drops dashboard. The CLI talks only to the authenticated Drops API and never receives direct Postgres or R2 credentials.

## Licence

MIT. See [LICENSE](LICENSE).
