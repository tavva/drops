# Agent-Discoverable CLI Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed Drops CLI teach humans and agents its complete workflow through human and machine-readable help plus actionable errors.

**Architecture:** Add one immutable command-help catalogue and render it as either human text or a versioned JSON value. Intercept all help forms in the top-level dispatcher before strict command parsing. Extend `DropsCliError` with optional structured guidance and render that centrally so command parsers and runtime failures can provide recovery without duplicating output logic.

**Tech Stack:** TypeScript, Node.js `parseArgs`, Vitest, existing CLI output abstraction.

---

### Task 1: Shared help catalogue and dispatch

**Files:**
- Create: `packages/cli/src/help.ts`
- Create: `packages/cli/tests/help.test.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/output.test.ts`

- [ ] **Step 1: Write failing tests for root help, every command help form, and JSON help**

Assert that `drops`, `drops --help`, and `drops help` return a quick start and all five command names; assert that `drops deploy --help`, `drops help deploy`, `drops auth status --help`, and `drops help auth status` return focused help; assert that `--json` returns `helpVersion: 1` and structured commands without stderr output.

- [ ] **Step 2: Run the focused tests and confirm they fail because help is missing**

Run: `pnpm --dir packages/cli exec vitest run tests/help.test.ts tests/output.test.ts`

- [ ] **Step 3: Implement the catalogue, renderers, help request parser, and top-level interception**

Use a `CommandHelp` value for `login`, `init`, `deploy`, `auth status`, and `logout`, each containing `name`, `summary`, `usage`, `arguments`, `options`, `examples`, and `notes`. Export `parseHelpRequest(argv)`, `rootHelpValue()`, `commandHelpValue(name)`, `renderRootHelp()`, and `renderCommandHelp(name)`.

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run: `pnpm --dir packages/cli exec vitest run tests/help.test.ts tests/output.test.ts`

- [ ] **Step 5: Commit the help surface**

```bash
git add packages/cli/src/help.ts packages/cli/src/index.ts packages/cli/tests/help.test.ts packages/cli/tests/output.test.ts
git commit -m "feat(cli): add agent-discoverable help"
```

### Task 2: Structured actionable errors

**Files:**
- Modify: `packages/cli/src/errors.ts`
- Modify: `packages/cli/src/output.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/commands/login.ts`
- Modify: `packages/cli/src/commands/logout.ts`
- Modify: `packages/cli/src/commands/authStatus.ts`
- Modify: `packages/cli/src/commands/deploy.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/instance.ts`
- Modify: `packages/cli/src/deploy.ts`
- Test: `packages/cli/tests/output.test.ts`
- Test: `packages/cli/tests/commands-auth.test.ts`
- Test: `packages/cli/tests/deploy.test.ts`
- Test: `packages/cli/tests/instance.test.ts`

- [ ] **Step 1: Write failing tests for human and JSON guidance**

Require errors to expose nullable `usage` and `hint` plus an `examples` array in JSON. Require human failures to print `Usage:`, `Hint:`, and indented examples. Cover unknown commands, missing deploy arguments, missing instance configuration, and missing authentication.

- [ ] **Step 2: Run the focused tests and confirm the missing fields and messages fail**

Run: `pnpm --dir packages/cli exec vitest run tests/output.test.ts tests/commands-auth.test.ts tests/deploy.test.ts tests/instance.test.ts`

- [ ] **Step 3: Extend the error model and attach command-specific guidance**

Add `DropsCliErrorGuidance { usage?: string; hint?: string; examples?: string[] }`. Store it on `DropsCliError`; JSON output emits `usage`, `hint`, and `examples`, while human output appends only populated guidance. Provide catalogue-derived guidance helpers so parser failures always point to `drops <command> --help` and include a valid invocation.

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run: `pnpm --dir packages/cli exec vitest run tests/output.test.ts tests/commands-auth.test.ts tests/deploy.test.ts tests/instance.test.ts`

- [ ] **Step 5: Commit actionable errors**

```bash
git add packages/cli/src packages/cli/tests
git commit -m "feat(cli): add actionable error guidance"
```

### Task 3: Documentation and release verification

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`

- [ ] **Step 1: Document human and JSON help entry points**

Show `drops --help`, `drops deploy --help`, and `drops help --json`; explain that agents should start with JSON help and that errors include recovery fields.

- [ ] **Step 2: Run complete verification**

```bash
pnpm --dir packages/cli test
pnpm --dir packages/cli typecheck
pnpm --dir packages/cli build
pnpm lint
pnpm cli:pack:check
```

Expected: all commands exit 0; ordinary CLI tests skip only the opt-in live Keychain integration.

- [ ] **Step 3: Exercise the linked executable**

```bash
pnpm --dir packages/cli exec pnpm link --global
drops --help
drops deploy --help
drops help --json
```

Expected: rich human help for the first two commands and one parseable JSON document for the third.

- [ ] **Step 4: Commit docs and verification changes**

```bash
git add README.md packages/cli/README.md
git commit -m "docs(cli): explain agent help discovery"
```
