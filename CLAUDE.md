# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **Claude Code plugin** (safety gates + usage telemetry) that UK2 developers install in any
repo via `/plugin marketplace add UK2-Limited/uk2-claude-hooks`. It is a Node.js rewrite of the
hook suite originally built inside the Chimera repo's `.claude/hooks/` (bash+jq) — that bash
suite is the behavioural reference for the event schema, the `UK2_*`/`CHIMERA_*` env-var
fallback, and the file locations under the consuming project's `.claude/`. Config **files**
are a deliberate break from Chimera: they are JSON (`hooks.json` / `config.json`, unprefixed
camelCase keys) — the shell-style `hooks.env`/`config.env` files are intentionally no longer
read (see the migration section in README.md).

## Layout

- `.claude-plugin/plugin.json` — manifest. **Deliberately has no `version` field** so every
  commit ships as an update; don't add one without deciding to move to tagged releases.
- `.claude-plugin/marketplace.json` — this repo doubles as its own single-plugin marketplace.
- `hooks/hooks.json` — event wiring; scripts are invoked as
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js"`.
- `scripts/*.js` — one file per hook; `scripts/lib/common.js` (shared helpers, event
  envelope, fire-and-forget shipping) and `scripts/lib/ship.js` (Elasticsearch
  send/spool/flush; also a CLI run detached by `shipEvent`).
- `scripts/telemetry-backfill.js` — CLI, not a hook.
- `test/run.js` — the self-test suite; `test/fixtures/` — transcript + config fixtures.

## Hard rules

- **Zero npm dependencies.** Node built-ins only (`node:fs`, `node:crypto`, global `fetch`,
  …), `engines: node >= 18`. Do not add a package-lock or node_modules.
- **Fail open, always.** Every hook body runs inside `common.run()` which swallows all
  errors and exits 0. A hook may only influence the agent through the explicit contracts:
  `deny()` (PreToolUse), `block()` (PostToolUse/Stop), or `additionalContext`
  (SessionStart). Telemetry breakage must never block a tool call.
- **Never break the event schema silently.** Grafana dashboards and the Elasticsearch index
  consume these events; the schema table in README.md is the contract. Additive fields are
  fine; renames/removals need a deliberate decision.
- **Keep the `CHIMERA_*` env fallback — for environment variables.** All env access goes
  through `common.envc()` — never read `process.env.UK2_*` directly. This applies to env
  VARS only: Chimera-format `hooks.env`/`config.env` *files* are intentionally not read
  (JSON config files use unprefixed camelCase keys); hooks print a one-line stderr
  migration nag when a stale `.env` file is found.
- **Deterministic ship IDs.** Elasticsearch `_id` = sha1 of the JSON line, shared by the
  live shipper and the backfill CLI. Changing it breaks idempotent retries/dedupe.
- `protected-paths.js` is **inert until configured** — it acts only when a
  `protectedPaths` block exists in the consuming repo's `hooks.json` (keeping the default
  behaviour of the disabled Chimera gate). The Chimera `protected-paths.txt` file is
  intentionally not read (stderr migration nag only).
- `block-dangerous-bash.js` must never lose its floor: a malformed `hooks.json` falls back
  to the built-in rules (deliberate exception to the broken-config → skip convention), and
  there is no env kill switch. A configured `dangerousBash.rules` array replaces the
  built-ins — keep `hooks.json.example` in lockstep with `DEFAULT_RULES` (the
  "example config" tests enforce this).

## Development commands

```bash
node test/run.js          # full self-test (spawns each hook against a scratch project)
npm test                  # same thing
claude plugin validate .  # manifest sanity (expect only the intentional no-version warning)
```

The test suite must stay hermetic: it builds a throwaway git project in `$TMPDIR`, strips
ambient `UK2_*`/`CHIMERA_*`/`CI` vars, and points the shipper at a closed port
(`test/fixtures/telemetry-unreachable.json`) — it must never touch a real repo or a real
Elasticsearch. When adding a hook or event field, add a test in the same commit.

## Testing a change against a real project

Add this checkout as a local marketplace and install from it:

```
/plugin marketplace add /path/to/uk2-claude-hooks
/plugin install uk2-claude-hooks@uk2-claude-hooks
```

Do NOT enable the plugin in a repo whose own `.claude/settings.json` registers the same
hooks (pre-migration Chimera) — both copies run and telemetry double-logs.
