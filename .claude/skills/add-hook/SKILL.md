---
name: add-hook
description: Add a new hook script to this plugin — script, wiring, tests, and README in one commit. Use when creating a new hook, adding a hook event, or extending an existing hook's behavior.
---

# Add a hook

Checklist for adding a hook to uk2-claude-hooks. All five steps land in the **same commit**.

## 1. Script — `scripts/<name>.js`

- Node built-ins only (`node:fs`, `node:crypto`, global `fetch`). Zero npm deps.
- Wrap the entire body in `common.run(fn)` so every error is swallowed and the hook
  exits 0 (fail open). Study an existing hook of the same event type first:
  - PreToolUse gate → `scripts/block-dangerous-bash.js` (uses `deny(reason)`)
  - PostToolUse feedback → `scripts/compile-check.js` (uses `block(reason)`)
  - Telemetry emitter → `scripts/telemetry-posttool.js` (uses `logEvent()`)
- Read stdin via `common.readInput()`; env via `common.envc('KEY')` — **never**
  `process.env.UK2_*` directly (breaks the `CHIMERA_*` fallback).
- A hook may only influence the agent via `deny()` (PreToolUse), `block()`
  (PostToolUse/Stop), or `additionalContext` (SessionStart). Nothing else.

## 2. Wiring — `hooks/hooks.json`

Add under the right event with the existing invocation shape:

```json
{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js\"" }
```

Pick the narrowest `matcher` that works (`Bash`, `Edit|Write|MultiEdit`, `*`).

## 3. Tests — `test/run.js`

Add cases in the same commit. Use the existing helpers: `run('<name>.js', input, env)`,
then `wantDeny(name)` / `wantAllow(name)` / `check(name, cond)`. Cover at minimum:
- the gate/emit behavior you added,
- the fail-open path (malformed input, missing file → still allow, exit 0),
- agent-mode vs local differences if the hook checks `isAgentMode()`.

The suite must stay hermetic — it runs against the scratch project in `$TMPDIR` with
`UK2_*`/`CHIMERA_*`/`CI` stripped and the shipper pointed at a closed port.

## 4. Docs — `README.md`

Add a row to the Hooks table. If the hook emits telemetry, add its fields to the event
schema table — that table is the Grafana/Elasticsearch contract (additive only).

## 5. Verify

Run `/verify` (or: `node test/run.js` then `claude plugin validate .`).
