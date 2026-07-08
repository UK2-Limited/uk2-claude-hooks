# uk2-claude-hooks

UK2 Group's Claude Code plugin: safety gates + usage telemetry, installable in any repo.
Node.js rewrite of the hook suite originally built inside the Chimera repo. Zero runtime
dependencies — Node built-ins only (Node >= 18) plus `git` on PATH.

Every hook **fails open**: a broken hook, missing binary, unreadable file, or unreachable
Elasticsearch never blocks a tool call. Only explicit gate decisions (deny/block) do.

## Hooks

| Hook | Event | What it does |
|---|---|---|
| `block-dangerous-bash` | PreToolUse (Bash) | Hard floor under the permission allowlist: denies `rm -rf /~/.`, `git push --force`, `DROP/TRUNCATE` on non-test DBs, `docker compose down -v`. Human override: `UK2_ALLOW_DANGEROUS=1` (ignored in agent/CI mode). |
| `test-integrity` | PreToolUse (edits) | Flags edits that weaken test files (assertion count drops, introduced SKIP/TODO). Hard-deny in agent/CI mode, warn-only locally. |
| `protected-paths` | PreToolUse (edits) | Policy-driven write protection from `<project>/.claude/validation/protected-paths.txt`. **Currently disabled** (early exit, parity with the Chimera branch) — re-enable together with the skipped tests in `test/run.js`. |
| `compile-check` | PostToolUse (edits) | `perl -c` for `.pm`/`.pl` files inside the docker-compose `api` container; feeds compile errors back to Claude. Skips quietly when no container is running (i.e. in non-Chimera repos). |
| `telemetry-posttool` | PostToolUse (*) | Emits the per-call telemetry events (see schema below). |
| `stop-require-evidence` | Stop | Agent/CI mode only: refuses to finish until `.claude/state/verify.json` shows passing evidence for the current HEAD. Capped at 3 blocks. |
| `session-context` | SessionStart | Injects issue + acceptance criteria from `.claude/state/ticket.json` when present; records the wall-time baseline. |
| `session-summary` | SessionEnd | Per-session roll-up: token totals from the transcript, wall time, test/failure counts. |

`scripts/telemetry-backfill.js` is a CLI (not a hook): `node scripts/telemetry-backfill.js
[project-root]` bulk-imports previously accumulated local JSONL into Elasticsearch.
Idempotent — doc `_id`s are the sha1 of each line, the same scheme the live shipper uses.

## Install

```
/plugin marketplace add uk2group/uk2-claude-hooks
/plugin install uk2-claude-hooks@uk2-claude-hooks
```

Private-repo auth rides on your existing git credentials (`gh auth login`, SSH agent, or a
`GITHUB_TOKEN`/`GH_TOKEN` env var for non-interactive updates). The plugin has no `version`
field, so every commit to this repo is picked up as an update.

To auto-enable for a whole team, a consuming repo can add to its `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "uk2-claude-hooks": {
      "source": { "source": "github", "repo": "uk2group/uk2-claude-hooks" }
    }
  },
  "enabledPlugins": { "uk2-claude-hooks@uk2-claude-hooks": true }
}
```

> **Do not enable this plugin in a repo whose own `.claude/settings.json` still registers
> these hooks** (e.g. Chimera before its hook-removal PR lands) — both copies would run and
> every telemetry event would be logged twice.

## Configure telemetry shipping

Without config, hooks only write local JSONL under `<project>/.claude/telemetry/` — shipping
is off. To ship to Elasticsearch:

1. Copy `telemetry.env.example` to `<project>/.claude/telemetry/config.env`, `chmod 600` it.
2. Fill in `UK2_TELEMETRY_ES_URL` (+ API key / Cloudflare Access token as needed).
3. Make sure the consuming repo gitignores `.claude/telemetry/` and `.claude/state/`.

Kill switch: `UK2_TELEMETRY_DISABLE=1` (env or config.env). Failed sends spool to
`.claude/telemetry/unshipped.jsonl` and drain automatically on later events, or in bulk via
the backfill CLI.

**Legacy names**: every `UK2_*` variable also accepts its `CHIMERA_*` twin (env and
config.env), so pre-plugin Chimera configs work unchanged. Other knobs:
`UK2_TELEMETRY_CONFIG` / `UK2_TELEMETRY_SPOOL` (override paths), `UK2_AGENT_MODE` (enables
the hard gates; `CI=true` does too), `UK2_ISSUE` (issue attribution), `UK2_DEVENV_DIR`
(where docker-compose lives for compile-check; default `<project>/..`).

## Event schema

Every event carries `ts`, `event`, `session_id`, `branch`, `user` (git config user.email,
`$USER` fallback), `host` (short hostname), `issue` (from `UK2_ISSUE` or
`.claude/state/ticket.json`, else null). Per-type fields:

| Event | Fields |
|---|---|
| `tool_use` | `tool`, `ok`, `message_id`, `tokens_in/out`, `tokens_cache_read/created`. Token counts are those of the assistant **message** that issued the call — parallel tool calls in one message share the numbers, so dedupe on `message_id` when summing. |
| `skill_use` | `skill`, `args` (truncated), `ok` |
| `agent_use` | `agent_type`, `description`, `model`, `model_source` (`override` = explicit in the call, `agent-def` = agent frontmatter, `session` = inherited session model inferred from the transcript), `ok` |
| `test_run` | `command`, `target`, `exit_code`, `passed`, `failed`, `tests_run`, `duration_ms` |
| `tool_failure` | `tool`, `exit_code`, `command`, `error_summary` |
| `compile_fail` | `file`, `error` |
| `dangerous_bash_blocked` / `protected_deny` / `protected_warn` / `test_integrity` / `stop_gate_exhausted` | gate-specific detail fields |
| `session_summary` | `end_reason`, `wall_ms`, `tests_run`, `tool_failures`, `compile_fails`, `tool_calls`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `total_tokens`, `turns`, `est_cost_usd` |

Note: `tool_failure.command`, `test_run.command` and `skill_use.args` ship truncated but
**unredacted** — treat the index accordingly (same caveat the in-repo bash hooks had).

## Development

```
node test/run.js        # self-test: spawns every hook against a throwaway project dir
claude plugin validate . # manifest sanity
```

The test suite never touches a real repo or a real Elasticsearch: it builds a scratch git
project in `$TMPDIR` and points the shipper at a closed port to exercise the spool path.
