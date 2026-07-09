# Public repository instruction split and history scrub

## Goal

Keep shared agent guidance useful in the public repository while keeping maintainer-specific deployment inventory and operational notes local. Remove personal deployment identifiers from every reachable Git commit and commit message, then replace the public `main` history.

## Instruction files

- `AGENTS.md` becomes the canonical tracked agent guide. It contains the current commands, architecture, security constraints, conventions, and deployment facts that apply to any checkout.
- `CLAUDE.md` contains exactly `@AGENTS.md` so Claude Code consumes the same shared guide without duplicating it.
- `CLAUDE.local.md` contains the maintainer's concrete instance inventory and private deployment runbook. It is ignored by Git and loaded automatically by Claude Code alongside the tracked guide.
- `.gitignore` explicitly ignores `/CLAUDE.local.md`.

The generic deployment guidance stays public: the Docker image runs migrations on startup, multiple instances use separate infrastructure, the service port must match wildcard-domain routing, and staged Railway deployment commands use placeholders. Concrete domains, project names, infrastructure identifiers, service counts, deployment side effects, and instance-specific smoke checks stay local.

## Current-tree sanitisation

Tracked examples must describe the product without identifying a real deployment:

- Historical design documents use reserved example domains.
- Preview fixtures use a neutral username, drop name, and example host.
- CLI design examples use reserved example domains and neutral users.
- Earlier organisation-specific names, domains, email addresses, usernames, and deployment details are replaced with neutral equivalents.

Repository-owner metadata that is intrinsic to the public project, such as the package repository URL and Git author metadata, is not part of the scrub. The boundary is deployment/customer identity and personal test or operational data.

## History rewrite

Use `git filter-repo` with deterministic replacement rules across every local branch and remote-tracking ref. Rewrite blob contents and commit messages. Preserve commit topology, authorship, timestamps, and unrelated content; all affected commit IDs will necessarily change.

The replacement set covers:

- Real app, content, and wildcard domains, including superseded deployments.
- Personal and organisation email addresses used in early plans, migrations, fixtures, and tests.
- Instance, customer, organisation, project, and drop names that identify real deployments.
- Railway project, environment, and service identifiers.
- Identifying wording in commit messages.

Before the rewrite, create a timestamped Git bundle outside the repository with permissions set to `0600`. It is a local recovery artifact and must never be pushed or copied into the public repository.

## Remote update

Record the current remote `main` object ID before rewriting. After verification, push rewritten `main` with an explicit force-with-lease bound to that object ID. Abort if the remote moved in the meantime. The history-only update will still trigger services configured to deploy on changes to `main`; no runtime behaviour should change.

Other clones and forks will retain the old objects. Git history rewriting removes the identifiers from the repository's advertised history, not from existing clones, caches, pull-request diffs, or third-party archives.

## Verification

Verification is performed on the rewritten repository before pushing and repeated against the fetched remote after pushing:

1. Scan every blob and commit message reachable from every remaining ref using an explicit deny-list of all known personal identifiers and infrastructure IDs.
2. Confirm `CLAUDE.md` is exactly one import line, `AGENTS.md` contains the shared guide, `CLAUDE.local.md` is ignored and untracked, and the local runbook retained all pre-existing local edits.
3. Inspect the final tree diff to ensure only instruction structure and example sanitisation changed.
4. Run formatting/linting, type checking, and the relevant test suite because one tracked preview fixture changes.
5. Force-push with the saved lease, fetch the remote, and repeat the history scan over `origin/main`.

## Failure handling

- If the working tree contains unrelated edits, preserve them and restrict commits to explicitly named paths.
- If a replacement creates malformed source or documentation, fix the replacement map and rerun from the local bundle rather than layering ad hoc history edits.
- If any deny-list match remains, do not push.
- If the remote lease fails, stop and inspect the new remote commits instead of overriding them.
- If verification fails after the remote update, restore from the local bundle with another leased force-push only after identifying the cause.
