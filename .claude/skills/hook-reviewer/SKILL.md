---
name: hook-reviewer
description: Review a new or changed hook script against this plugin's invariants (fail-open, zero deps, env fallback, event contracts, schema stability). Use when reviewing a diff or PR that touches scripts/, hooks/hooks.json, or scripts/lib/.
---

# Hook review checklist

Review the changed hook(s) against each invariant below. Report violations with
`file:line` references; verify each claim against the actual code before reporting it.

## 1. Fail open

- The entire hook body runs inside `common.run(fn)`. Nothing that can throw sits
  outside it. No `process.exit(non-zero)` except via `deny()`/`block()`.
- Missing files, malformed stdin, absent binaries, unreachable Elasticsearch must all
  end in a silent exit 0. Telemetry breakage must never block a tool call.

## 2. Zero dependencies

```bash
grep -rn "require(" scripts/ | grep -v "require('node:" | grep -v "require('./" | grep -v "require('../"
```

Anything that isn't a `node:` built-in or a relative path is a violation. Also check
no `package-lock.json` / `node_modules` appeared in the diff.

## 3. Env access

- All `UK2_*` reads go through `common.envc()` (which handles the `CHIMERA_*`
  fallback). `grep -n "process.env.UK2" scripts/` must only hit `lib/common.js`.

## 4. Agent-influence contract

A hook may only influence the agent through the channel allowed for its event:

| Event | Allowed channel |
|---|---|
| PreToolUse | `deny(reason)` |
| PostToolUse / Stop | `block(reason)` |
| SessionStart | `additionalContext` |
| SessionEnd | none (telemetry only) |

Check the hook's `hooks/hooks.json` entry matches the channel it uses, and the
`matcher` is the narrowest that works.

## 5. Schema & ship-ID stability

- New telemetry fields: additive only, present in the README schema table, asserted in
  a test. Renames/removals of existing fields need explicit user sign-off.
- Nothing may change how existing event lines serialize (key order, defaults,
  whitespace) — the Elasticsearch `_id` is the sha1 of the line; changing it breaks
  idempotent retries. Flag any change to `logEvent()`/`ship.js` serialization.

## 6. Tests in the same commit

- Every new gate/emit behavior has a `test/run.js` case, including its fail-open path.
- Tests stay hermetic: scratch project only, no real repo, no real Elasticsearch, no
  ambient `UK2_*`/`CHIMERA_*`/`CI`.
- The 3 skipped `protected-paths` tests stay skipped unless the hook is re-enabled in
  the same change.

## 7. Docs

- New hook → new row in the README hooks table. New event/field → schema table row.

Finish by running `node test/run.js` and `claude plugin validate .` and including the
results in the review.
