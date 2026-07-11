# @tavva/drops-cli

The command-line client for publishing local files, folders, and zip archives to a Drops instance.

## Install

```bash
pnpm add --global @tavva/drops-cli
```

The CLI requires Node.js 22 or newer and currently supports macOS credential storage. Browser-approved bearer credentials are stored in macOS Keychain, keyed by the instance's exact origin.

## Use

```bash
drops login https://drops.example.com
drops init --instance https://drops.example.com
drops deploy ./dist --name preview --json
drops auth status --json
drops logout
```

Commit the generated `.drops.json` if you want the repository to share its default instance. It contains only the instance origin, never credentials. Each deploy requires an explicit `--name`; use `--instance` to override the repository default when working with another independently authenticated instance.

`drops logout` revokes the local authorisation. You can also revoke active CLI access from the Drops dashboard. The CLI talks only to the authenticated Drops API and never receives direct Postgres or R2 credentials.

## Licence

MIT. See [LICENSE](LICENSE).
