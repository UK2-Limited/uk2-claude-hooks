# uk2-claude-hooks

UK2 Group's Claude Code plugin: safety gates + usage telemetry, installable in any repo.
Node.js rewrite of the hook suite originally built inside the Chimera repo. Zero runtime
dependencies — Node built-ins only (Node >= 18) plus `git` on PATH.

Every hook **fails open**: a broken hook, missing binary, unreadable file, or unreachable
Elasticsearch never blocks a tool call. Only explicit gate decisions (deny/block) do.

## Hooks

| Hook | Event | What it does |
|---|---|---|
| `block-dangerous-bash` | PreToolUse (Bash) | Hard floor under the permission allowlist: denies `rm -rf /~/.`, `git push --force`, `DROP/TRUNCATE` on non-test DBs, `docker compose down -v`. Rule set replaceable via `hooks.json` (defaults spelled out in `hooks.json.example`). Human override: `UK2_ALLOW_DANGEROUS=1` (ignored in agent/CI mode). |
| `test-integrity` | PreToolUse (edits) | Flags edits that weaken test files (assertion count drops, introduced SKIP/TODO). Hard-deny in agent/CI mode, warn-only locally. Perl heuristics by default; file/assertion/skip regexes overridable via `hooks.json`. |
| `protected-paths` | PreToolUse (edits) | Policy-driven write protection: `deny` (hard deny, holds under bypassPermissions) and `warn` (allow + advisory + telemetry) path patterns from `protectedPaths` in `hooks.json`. **Inert until configured** — with no `protectedPaths` key it does nothing (parity with the Chimera branch, where this gate shipped disabled). The Chimera-era `protected-paths.txt` file is no longer read. |
| `compile-check` | PostToolUse (edits) | Compile/syntax-checks the edited file and feeds errors back to Claude. Configurable as an array of command steps (file-match regex + shell command) via `hooks.json`; with no steps configured it defaults to `perl -c` for `.pm`/`.pl` inside the docker-compose `api` container, skipping quietly when no container is running (i.e. in non-Chimera repos). |
| `telemetry-posttool` | PostToolUse (*) | Emits the per-call telemetry events (see schema below). |
| `stop-require-evidence` | Stop | Agent/CI mode only: refuses to finish until `.claude/state/verify.json` shows passing evidence for the current HEAD — or, via `hooks.json`, until every project-defined verify command exits 0. Block message and cap (default 3) configurable. |
| `session-context` | SessionStart | Injects issue + acceptance criteria from `.claude/state/ticket.json` when present; records the wall-time baseline. |
| `session-summary` | SessionEnd | Per-session roll-up: token totals from the transcript (incl. sub-agent transcripts), wall time, test/failure counts. |

`scripts/telemetry-backfill.js` is a CLI (not a hook): `node scripts/telemetry-backfill.js
[project-root]` bulk-imports previously accumulated local JSONL into Elasticsearch.
Idempotent — doc `_id`s are the sha1 of each line, the same scheme the live shipper uses.

`scripts/telemetry-verify.js` is also a CLI (not a hook): `node scripts/telemetry-verify.js
[project-root] [--session <id>] [--projects-dir <dir>] [--json]` cross-checks the local
telemetry against the actual Claude Code transcripts (`~/.claude/projects/…`) — recomputes
every summary's token fields, checks `tool_use` invariants and
`sessions/` ↔ `summaries.jsonl` consistency, and reports spool health. Strictly read-only;
exits 0 when clean, 1 on discrepancies, 2 on usage errors. A pruned transcript is a skip,
not a failure; summaries shipped before the 2026-07 dedupe fix will report their (real)
historical inflation.

## Install

```
/plugin marketplace add UK2-Limited/uk2-claude-hooks
/plugin install uk2-claude-hooks@uk2-claude-hooks
```

Private-repo auth rides on your existing git credentials (`gh auth login`, SSH agent, or a
`GITHUB_TOKEN`/`GH_TOKEN` env var for non-interactive updates). The plugin has no `version`
field, so every commit to this repo is picked up as an update.

**Updates are not automatic by default.** Third-party marketplaces ship with auto-update
off, so either enable it once in the `/plugin` UI (Marketplaces → uk2-claude-hooks →
auto-update) — after which every commit is picked up at Claude Code startup — or refresh
manually with `/plugin marketplace update uk2-claude-hooks`.

To auto-enable for a whole team, a consuming repo can add to its `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "uk2-claude-hooks": {
      "source": { "source": "github", "repo": "UK2-Limited/uk2-claude-hooks" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "uk2-claude-hooks@uk2-claude-hooks": true }
}
```

> **Do not enable this plugin in a repo whose own `.claude/settings.json` still registers
> these hooks** (e.g. Chimera before its hook-removal PR lands) — both copies would run and
> every telemetry event would be logged twice.

Add `.claude/telemetry/` and `.claude/state/` to the consuming repo's `.gitignore` — the
hooks write local JSONL telemetry and state files there from the very first session, even
with shipping unconfigured.

## Configure the gates (`hooks.json`)

The gates take per-project config from
`<project>/.claude/validation/hooks.json` (copy `hooks.json.example`; commit it — no
secrets in it; override the path with `UK2_HOOKS_CONFIG`). Without the file, every gate
keeps its built-in Chimera behaviour (and `protected-paths` stays off).

```json
{
  "dangerousBash": {
    "rules": [
      { "reason": "no writes to the prod bucket",
        "match": ["aws\\s+s3\\s+(rm|sync|cp)", "s3://prod-"] }
    ]
  },
  "protectedPaths": {
    "deny": ["conf/production/", "**/.env", "**/secrets/**"],
    "warn": ["database/structure/"]
  },
  "compileCheck": {
    "steps": [
      { "match": "\\.tsx?$", "cmd": "npx tsc --noEmit", "timeoutMs": 120000 },
      { "match": "\\.py$", "cmd": "python -m pyflakes {file} 2>&1 || true",
        "errorRe": "undefined name|invalid syntax" }
    ]
  },
  "testIntegrity": {
    "fileRe": "\\.test\\.[jt]sx?$",
    "assertRe": "\\bexpect\\s*\\(",
    "skipRe": "\\b(it|test|describe)\\.skip\\b"
  },
  "stopGate": {
    "cmds": ["npm test", "npm run lint"]
  }
}
```

**dangerousBash** — `rules` is an array checked against every statement of the command
(compound commands are split on `;`/`&&`/`||`/`|`/newline first). Per rule: `reason`
(required, shown in the deny), `match` (required; case-insensitive regexes that must ALL
hit the same statement), `noMatch` (none may hit — e.g. exempting `test` databases). A
configured `rules` array **replaces** the built-ins, so start from the defaults in
`hooks.json.example` and add to them. An invalid rule is skipped with a stderr note; the
rest still apply. Deviation from the other gates: a *malformed* `hooks.json` does not
switch this gate off — the built-in rules keep applying, so a parse error can never drop
the floor. There is deliberately no env kill switch; `UK2_ALLOW_DANGEROUS=1` is the local
human override (ignored in agent/CI mode).

**protectedPaths** — `deny` and `warn` are arrays of path patterns matched against the
repo-relative path of every `Edit`/`Write`/`MultiEdit`/`NotebookEdit`. `deny` hard-denies
(holds under bypassPermissions); `warn` allows with a stderr advisory + telemetry flag.
Pattern semantics: trailing `/` = directory prefix, leading `**/` = any depth, `*` is a
glob that crosses `/`. Without a `protectedPaths` key the hook does nothing; a leftover
Chimera `protected-paths.txt` is not read (stderr nag only).

**compileCheck** — `steps` is an array run in order for every matching edited file; the
first failing step blocks with the command's output. Adding another check is adding another
object to the array — there is no step limit. Per step: `cmd` (required; non-zero exit
blocks), `match` (path regex; omit to match every file), `cwd` (default `{root}`),
`precheck` (non-zero exit → skip the step quietly, e.g. "is the container up"), `errorRe`
(also fail when the output matches, even at exit 0), `timeoutMs` (default 60000).
Placeholders in `cmd`/`precheck`/`cwd`: `{file}` (repo-relative path, shell-quoted),
`{root}`, `{devenv}`. With no `steps` key, the built-in Chimera default runs (`perl -c` in
the docker-compose `api` container for `*.pm`/`*.pl`); an explicit empty `"steps": []`
means "no checks".

**testIntegrity** — swap the Perl heuristics for your test dialect (set the three
together): `fileRe` (which paths count as tests), `assertRe` (assertion pattern, counted
before/after, flag `g`), `skipRe` (skip/TODO pattern, flags `im`).

**stopGate** — `cmds` is an array of shell commands run in order; **all** must exit 0 to
count as evidence (replacing the `verify.json` sentinel). The first failure blocks with
that command's output; the rest are not run. `{root}`/`{head}` placeholders. Other keys:
`message` (custom block text, `{head}`/`{root}` placeholders), `maxBlocks` (default 3),
`timeoutMs` (per command, default 120000).

Each gate also takes `"disable": true` in its block, or an environment kill switch that
works without editing the committed file (handy in CI): `UK2_COMPILE_CHECK_DISABLE`,
`UK2_TEST_INTEGRITY_DISABLE`, `UK2_STOP_GATE_DISABLE`, `UK2_PROTECTED_PATHS_DISABLE`
(`dangerousBash` has no env kill switch by design — see above).

Everything stays fail-open: a missing or malformed `hooks.json`, invalid regex, or a
command that cannot run (missing binary, timeout) skips the check with a stderr note —
only a real non-zero exit (or `errorRe` match) blocks. Sole exception: `dangerousBash`
falls back to its built-in rules on a malformed `hooks.json`.

## Configure telemetry shipping

Without config, hooks only write local JSONL under `<project>/.claude/telemetry/` — shipping
is off. To ship to Elasticsearch:

1. Copy `telemetry.json.example` to `<project>/.claude/telemetry/config.json`, `chmod 600` it.
2. Fill in `esUrl` (+ `esApiKey` / `cfClientId`+`cfClientSecret` as needed; `esIndex`
   defaults to `claude-telemetry`).
3. Make sure the consuming repo gitignores `.claude/telemetry/` and `.claude/state/`.

Kill switch: `UK2_TELEMETRY_DISABLE=1` in the environment, or `"disable": true` in
`config.json`. Failed sends spool to `.claude/telemetry/unshipped.jsonl` and drain
automatically on later events, or in bulk via the backfill CLI.

**Environment variables**: every `UK2_*` variable also accepts its `CHIMERA_*` twin.
Knobs: `UK2_TELEMETRY_CONFIG` / `UK2_TELEMETRY_SPOOL` / `UK2_HOOKS_CONFIG` (override
paths), `UK2_AGENT_MODE` (enables the hard gates; `CI=true` does too), `UK2_ISSUE` (issue
attribution), `UK2_DEVENV_DIR` (where docker-compose lives for compile-check's default
step; default `<project>/..`), plus the four gate kill switches above.

## Migrating from `hooks.env` / `config.env`

**Breaking change**: the plugin no longer reads the shell-style
`.claude/validation/hooks.env` or `.claude/telemetry/config.env` files — config files are
JSON now. The same applies to `.claude/validation/protected-paths.txt`: its deny/warn
rules move into the `protectedPaths` block of `hooks.json`. Until converted, the gates fall back to their built-in defaults and telemetry
shipping is off (local JSONL still accumulates and can be backfilled afterwards); hooks
print a one-line stderr nag while a stale `.env` file is present. `UK2_*`/`CHIMERA_*`
*environment variables* for mode, paths, and kill switches are unaffected.

| Old env-file key | New JSON key |
|---|---|
| `UK2_COMPILE_CHECK_<n>_CMD/_MATCH/_CWD/_PRECHECK/_ERROR_RE/_TIMEOUT_MS` | `compileCheck.steps[i].cmd/match/cwd/precheck/errorRe/timeoutMs` (array order = run order; no more 20-step cap) |
| `UK2_COMPILE_CHECK_DISABLE` | `compileCheck.disable` (env var still works) |
| `UK2_TEST_INTEGRITY_FILE_RE/_ASSERT_RE/_SKIP_RE` | `testIntegrity.fileRe/assertRe/skipRe` |
| `UK2_TEST_INTEGRITY_DISABLE` | `testIntegrity.disable` (env var still works) |
| `UK2_STOP_GATE_CMD` | `stopGate.cmds` (now an array — all must pass) |
| `UK2_STOP_GATE_TIMEOUT_MS/_MAX_BLOCKS/_MESSAGE` | `stopGate.timeoutMs/maxBlocks/message` |
| `UK2_STOP_GATE_DISABLE` | `stopGate.disable` (env var still works) |
| `protected-paths.txt` lines (`deny:<pat>` / `warn:<pat>`) | `protectedPaths.deny[]` / `protectedPaths.warn[]` (same pattern semantics) |
| `UK2_TELEMETRY_ES_URL/_ES_INDEX/_ES_API_KEY` | `esUrl` / `esIndex` / `esApiKey` in `config.json` |
| `UK2_TELEMETRY_CF_CLIENT_ID/_SECRET` | `cfClientId` / `cfClientSecret` |
| `UK2_TELEMETRY_DISABLE` | `disable` (env var still works) |

Delete the old `.env` files once converted to silence the migration nag.

## Event schema

Every event carries `ts`, `event`, `session_id`, `branch`, `repo` (`org/repo` parsed
from the origin remote URL; folder basename when there is no remote/repo), `user`
(git config user.email, `$USER` fallback), `host` (short hostname), `issue` (from
`UK2_ISSUE` or `.claude/state/ticket.json`, else null), `subagent` (`true` when the
event came from a tool call made by a sub-agent — Task/Agent tool or Workflow
fan-outs; hooks fire for those too, under the parent's `session_id`) and `agent_id`
(the sub-agent's id, `null` for main-loop events). Per-type fields:

| Event | Fields |
|---|---|
| `tool_use` | `tool`, `ok`, `message_id`, `model` (of the issuing assistant message; `null` when unknown), `command` (Bash calls only — first 200 chars, path-normalized per the note below; absent on other tools), `file_path` (file-path tools only — Read/Edit/Write/MultiEdit/NotebookEdit, from the call's `file_path`/`notebook_path` input; first 300 chars, path-normalized per the note below; absent on other tools), `tokens_in/out`, `tokens_cache_read/created`. Token counts are those of the assistant **message** that issued the call — parallel tool calls in one message share the numbers, so dedupe on `message_id` when summing (that also makes `tool_use` the right source for per-model cost). For sub-agent calls (`subagent: true`) the counts come from the sub-agent's own transcript; `null` when that transcript can't be found. |
| `skill_use` | `skill`, `args` (truncated), `ok` |
| `agent_use` | `agent_type`, `description`, `model`, `model_source` (`override` = explicit in the call, `agent-def` = agent frontmatter, `session` = inherited session model inferred from the transcript), `spawned_agent_id` (the launched sub-agent's id — join it against other events' `agent_id`; `null` when the response doesn't carry one), `ok` |
| `edit` | `tool`, `file_path` (repo-relative), `lines_added`, `lines_removed`, `permission_mode` — counted from the tool's `structuredPatch`; for a Write that creates a new file (empty patch) `lines_added` is counted from the accepted content; both counts `null` when no patch is available (e.g. NotebookEdit). Emitted only for **successful** Edit/Write/MultiEdit/NotebookEdit calls; failed edits show up as `tool_failure` instead. |
| `test_run` | `command`, `target`, `exit_code`, `passed`, `failed`, `tests_run`, `duration_ms` |
| `tool_failure` | `tool`, `exit_code`, `command`, `error_summary` |
| `compile_fail` | `file`, `error`; configured steps add `step`, `cmd` |
| `dangerous_bash_blocked` / `protected_deny` / `protected_warn` / `test_integrity` / `stop_gate_exhausted` | gate-specific detail fields |
| `session_summary` | `end_reason`, `wall_ms`, `tests_run`, `tool_failures`, `compile_fails`, `tool_calls`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `total_subagent_tokens` (sub-agent input + output), `total_subagent_cache_tokens` (sub-agent cache creation + read), `total_tokens` (input + output + sub-agent), `total_cache_tokens` (cache creation + read + sub-agent), `turns`, `model` (last main-loop assistant model — a label; cost mixed-model sessions from `tool_use` events instead). `input_tokens`/`output_tokens`/cache fields and `turns` cover the **main loop only**; usage from sub-agent transcripts (Task/Agent tool, Workflow fan-outs, stored under the session's `subagents/` dir) is summed into the `total_subagent_*` fields and included in the two grand totals. Token sums are **deduped per assistant message** — the transcript repeats a message's usage once per content block, and inline sidechain (sub-agent) turns are excluded — so `turns` = unique assistant messages. Summaries shipped before this dedupe landed (2026-07) are inflated roughly 3–4× and carried a never-populated `est_cost_usd` (dropped 2026-07 — compute cost downstream from tokens + `model`); expect a step drop in dashboards at that date. |

Note: the `command` fields (`tool_use`, `tool_failure`, `test_run`,
`dangerous_bash_blocked`) and `tool_use.file_path` are **path-normalized before
truncation** so identical commands aggregate across users/checkouts: paths under
the session working directory become relative, a bare cwd becomes `.`, and a
remaining `$HOME` prefix folds to `~` (since 2026-07; earlier events carry
absolute paths).
They and `skill_use.args` still ship **unredacted** — treat the index
accordingly (same caveat the in-repo bash hooks had).

## Development

```
node test/run.js        # self-test: spawns every hook against a throwaway project dir
claude plugin validate . # manifest sanity
```

The test suite never touches a real repo or a real Elasticsearch: it builds a scratch git
project in `$TMPDIR` and points the shipper at a closed port to exercise the spool path.
