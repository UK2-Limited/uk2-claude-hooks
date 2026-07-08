---
name: verify
description: Verify this plugin end-to-end — run the hermetic self-test suite and validate the plugin manifest, and know which warnings/skips are intentional. Use before committing, after changing any hook, or when asked whether the plugin works.
---

# Verify uk2-claude-hooks

Run both, in order:

```bash
node test/run.js          # hermetic self-test: spawns each hook against a scratch project
claude plugin validate .  # manifest sanity
```

## Reading the results

- `test/run.js` must end `RESULT: N passed, 0 failed, 0 skipped`.
  - Any `fail` is a real failure — report it with the output, don't rationalize it.
- `claude plugin validate .` is expected to warn about the **missing `version` field** —
  that is deliberate (versionless → every commit ships as an update). Any *other*
  warning or error is real.

## For behavior changes, also exercise a hook directly

The hooks are plain stdin→stdout Node scripts, so you can drive one by hand:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | node scripts/block-dangerous-bash.js
# expect: {"hookSpecificOutput":{...,"permissionDecision":"deny",...}}
```

For a full integration check against a real Claude Code session, install this checkout
as a local marketplace (see "Testing a change against a real project" in CLAUDE.md) —
but never in a repo whose own `.claude/settings.json` still registers the same hooks.

## Never do during verification

- Point the shipper at a real Elasticsearch or a real repo — tests must stay hermetic.
- Set `UK2_*`/`CHIMERA_*` vars in your own environment when running the suite.
