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
| `test-integrity` | PreToolUse (edits) | Flags edits that weaken test files (assertion count drops, introduced SKIP/TODO). Hard-deny in agent/CI mode, warn-only locally. Perl heuristics by default; file/assertion/skip regexes overridable via `hooks.env`. |
| `protected-paths` | PreToolUse (edits) | Policy-driven write protection from `<project>/.claude/validation/protected-paths.txt`. **Currently disabled** (early exit, parity with the Chimera branch) — re-enable together with the skipped tests in `test/run.js`. |
| `compile-check` | PostToolUse (edits) | Compile/syntax-checks the edited file and feeds errors back to Claude. Configurable as numbered command steps (file-match regex + shell command) via `hooks.env`; with no steps configured it defaults to `perl -c` for `.pm`/`.pl` inside the docker-compose `api` container, skipping quietly when no container is running (i.e. in non-Chimera repos). |
| `telemetry-posttool` | PostToolUse (*) | Emits the per-call telemetry events (see schema below). |
| `stop-require-evidence` | Stop | Agent/CI mode only: refuses to finish until `.claude/state/verify.json` shows passing evidence for the current HEAD — or, via `hooks.env`, until a project-defined verify command exits 0. Block message and cap (default 3) configurable. |
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

## Configure the gates (`hooks.env`)

The three Chimera-flavoured gates take per-project config from
`<project>/.claude/validation/hooks.env` (copy `hooks.env.example`; commit it — no secrets
in it; override the path with `UK2_HOOKS_CONFIG`). Same shell-style `KEY="value"` format as
the telemetry config; every key also works as a plain env var (file wins), and every
`UK2_*` name accepts a `CHIMERA_*` twin. Without the file, all three keep their built-in
Chimera behaviour.

**compile-check** — numbered steps run in order for every matching edited file; the first
failing step blocks with the command's output. Placeholders in commands/cwd: `{file}`
(repo-relative path, shell-quoted), `{root}`, `{devenv}`.

```
UK2_COMPILE_CHECK_1_MATCH="\.tsx?$"        # path regex; omit to match every file
UK2_COMPILE_CHECK_1_CMD="npx tsc --noEmit" # required; non-zero exit blocks
UK2_COMPILE_CHECK_1_CWD="{root}"           # optional
UK2_COMPILE_CHECK_1_PRECHECK="..."         # optional; non-zero exit -> skip step quietly
UK2_COMPILE_CHECK_1_ERROR_RE="..."         # optional; also fail when output matches (even at exit 0)
UK2_COMPILE_CHECK_1_TIMEOUT_MS=60000       # optional
UK2_COMPILE_CHECK_DISABLE=1                # kill switch
```

**test-integrity** — swap the Perl heuristics for your test dialect (set the three
together): `UK2_TEST_INTEGRITY_FILE_RE` (which paths count as tests),
`UK2_TEST_INTEGRITY_ASSERT_RE` (assertion pattern, counted before/after, flag `g`),
`UK2_TEST_INTEGRITY_SKIP_RE` (skip/TODO pattern, flags `im`),
`UK2_TEST_INTEGRITY_DISABLE`.

**stop-require-evidence** — `UK2_STOP_GATE_CMD` (exit 0 = evidence, replacing the
`verify.json` sentinel; `{root}`/`{head}` placeholders; failure output is fed back to
Claude), `UK2_STOP_GATE_MESSAGE` (custom block text, `{head}` placeholder),
`UK2_STOP_GATE_MAX_BLOCKS` (default 3), `UK2_STOP_GATE_TIMEOUT_MS` (default 120000),
`UK2_STOP_GATE_DISABLE`.

Everything stays fail-open: an unreadable file, invalid regex, or a command that cannot
run (missing binary, timeout) skips the check with a stderr note — only a real non-zero
exit (or `ERROR_RE` match) blocks.

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
`UK2_TELEMETRY_CONFIG` / `UK2_TELEMETRY_SPOOL` / `UK2_HOOKS_CONFIG` (override paths),
`UK2_AGENT_MODE` (enables the hard gates; `CI=true` does too), `UK2_ISSUE` (issue
attribution), `UK2_DEVENV_DIR` (where docker-compose lives for compile-check's default
step; default `<project>/..`).

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
| `compile_fail` | `file`, `error`; configured steps add `step`, `cmd` |
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
