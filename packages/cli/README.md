# @tavva/drops-cli

The command-line client for publishing and viewing files, folders, and zip archives to a Drops instance.

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

The CLI requires Node.js 22 or newer and supports macOS and Linux, including headless Linux servers. Credentials are keyed by the instance's exact origin. macOS uses Keychain; Linux uses local credential files (see below).

`drops login` prints its complete authorisation URL before trying to open the
browser, so you can copy and paste the URL if no window appears.

## Headless Linux

Run `drops login --instance https://drops.example.com` on the server. The CLI
prints an authorisation URL and an SSH forwarding command containing the callback
port selected for this login.

1. Leave login running on the server.
2. Run the printed SSH command in another terminal on your local computer,
   replacing `user@server` with your SSH destination. Keep that tunnel running.
3. Open the printed authorisation URL in your local browser and approve access.
4. Once the server reports successful login, close the SSH tunnel with Ctrl-C.

Approval must complete within five minutes. The callback stays bound to
`127.0.0.1`; no public callback port or desktop keyring is needed on the server.
The tunnel carries the local browser's callback to the server via
[SSH local forwarding](https://man.openbsd.org/ssh#L).
Subsequent deploy, list, view, status, and logout commands need no browser or tunnel.

Linux stores unencrypted bearer credentials in
`$XDG_CONFIG_HOME/drops/credentials/`, or `~/.config/drops/credentials/` when
`XDG_CONFIG_HOME` is unset or not absolute. The credential directory has mode
`0700` and each file has mode `0600`. The CLI rejects unsafe directory/file
permissions and symlink credential files when reading. These permissions protect
against other ordinary users, but the account owner and root can read the tokens.
Use the same Unix account for login and deployments; for containers, persist this
private directory if credentials must survive recreation. Credentials never go
in the repository's `.drops.json`.

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
drops init --instance https://drops.example.com
drops login
drops deploy ./dist --name preview --json
drops list
drops list preview
drops view preview
drops view preview assets/app.js
drops open preview
drops auth status --json
drops logout
```

`drops list` shows the drops you own on the selected instance; add a drop name to list that drop's files with sizes.

`drops view <name> [path]` reads a drop’s entry point or a particular file in the
terminal. HTML is displayed as source. Use `--json` for content and metadata;
binary files are base64 encoded. Terminal viewing supports files up to 10 MiB.
Use `owner/name` to read a drop shared with you, for example
`drops view alice/report notes.txt`.

`drops open <name> [path]` opens the drop in your browser using your saved CLI
login. It prints a private URL that must be opened within 60 seconds. On a
headless machine, copy this URL into a local browser; no SSH tunnel is needed.
Use `--no-browser` to skip browser launch, or `--no-browser --json` to retrieve
`openUrl` programmatically. This private URL grants access as you to the selected
drop; do not share it. Share the ordinary drop URL instead.

Both commands use the same viewing permissions as the website and accept
`--instance`. Browser access is scoped to the selected drop; revoking the CLI
credential also invalidates the browser access it granted.

Commit the generated `.drops.json` if you want the repository to share its default instance. It contains only the instance origin, never credentials. Every instance-selecting command, including `drops login`, uses the nearest `.drops.json` when you give no origin, and `drops login` names the origin and the file it came from before opening the browser. Each deploy requires an explicit `--name`; use `--instance` to override the repository default when working with another independently authenticated instance.

`drops logout` revokes the local authorisation. You can also revoke active CLI access from the Drops dashboard. The CLI talks only to the authenticated Drops API and never receives direct Postgres or R2 credentials.

## Licence

MIT. See [LICENSE](LICENSE).
