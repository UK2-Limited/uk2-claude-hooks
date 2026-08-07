# Design: ship the installed plugin version in telemetry

Date: 2026-08-07
Status: approved, ready for implementation planning

## Problem

Developers install this plugin once per project and then drift. There is currently no way
to tell, from the telemetry index, which build of the plugin any given developer is
actually running — so there is no way to spot who is stale and remind them to update.

Staleness is real and already observable locally. This machine holds four separately
pinned builds of the plugin:

```
~/.claude/plugins/cache/uk2-claude-hooks/uk2-claude-hooks/76a8f3bfe1c4/
                                                          3b9bae988e3f/
                                                          b5f3a0b280b1/
                                                          b050cc790029/
```

## Key finding: the version already exists

`.claude-plugin/plugin.json` deliberately carries no `version` field (see CLAUDE.md).
Because of that, Claude Code caches this plugin under its **12-character git commit SHA**.
Plugins that *do* declare a version are cached under the semver instead — e.g.
`cache/claude-plugins-official/superpowers/6.2.0/`.

`${CLAUDE_PLUGIN_ROOT}` therefore already *is* the version-keyed directory, and
`basename(pluginRoot)` is the exact commit the developer is running. No manifest change is
needed to obtain a version string.

Two supporting facts, both verified on disk:

- The plugin cache directory is a **materialised snapshot, not a git repo** — `git -C` on
  it fails. The commit SHA is recoverable only from the directory name.
- `~/.claude/plugins/installed_plugins.json` records `version`, `installPath` and
  `gitCommitSha` per project install.

## Decisions

**Version identity: commit SHA, no manifest change.** Adding a semver would reverse a
documented invariant — Claude Code would key the cache by version, so commits without a
bump would no longer ship as an update — while solving nothing: versioned plugins go stale
in exactly the same way (superpowers is pinned at 5.1.0, 6.1.1 and 6.2.0 across different
projects on this machine). The SHA is free, always accurate, and requires no bump
discipline.

**Reminder mechanism: Grafana panel only.** The maintainer reads the dashboard and pings
stragglers. An automatic in-session nudge was considered and rejected as unnecessary scope:
`session-context.js` could compare the installed SHA against the auto-updating marketplace
clone at `~/.claude/plugins/marketplaces/<name>/` (which *is* a git repo, currently at
`76a8f3bfe1c4`) entirely locally, with no network call. That option remains open later; it
is not part of this change.

## Design

### 1. Version resolution — `scripts/lib/common.js`

Two new exports. `resolvePluginVersion(root)` is pure and takes the root as an argument so
it is directly testable; `pluginVersion()` memoises it against the real plugin root
(`path.resolve(__dirname, '..', '..')`, derived from `__dirname` rather than
`CLAUDE_PLUGIN_ROOT` so it holds regardless of how the hook was invoked).

```js
// The identity Claude Code installed this plugin under. Versionless plugins are
// cached at <cache>/<marketplace>/<plugin>/<12-hex commit sha>/, so the plugin
// root's basename IS the shipped commit. A working checkout has no such name —
// fall back to git HEAD, tagged -local so a dashboard can tell a developer's
// tree from a published commit.
function resolvePluginVersion(root) {
  const m = readJsonConfig(path.join(root, '.claude-plugin', 'plugin.json'));
  if (m && typeof m.version === 'string' && m.version) return m.version;
  const base = path.basename(root);
  if (/^[0-9a-f]{7,40}$/.test(base)) return base;
  // Only accept HEAD when the root IS the repo top level (see note below).
  const top = gitOut(['rev-parse', '--show-toplevel'], root);
  let real = '';
  try { real = fs.realpathSync(root); } catch { /* root gone */ }
  if (top && real && top === real) {
    const sha = gitOut(['rev-parse', '--short=12', 'HEAD'], root);
    if (sha) return `${sha}-local`;
  }
  return 'unknown';
}
```

**Correction found during implementation.** The first draft of this spec called for a
bare `git rev-parse HEAD` on the root. That is wrong: `rev-parse` walks *up* the
directory tree, so a plugin directory that merely sits inside some unrelated checkout —
a git-tracked `$HOME`, which is a common dotfiles setup — would report that repo's HEAD
as the plugin version. The `--show-toplevel` versus `realpath` comparison above rejects
it, reusing the idiom `gitInfoFor()` already uses in the same file. The test for the
`unknown` branch pins this, since the fixture directories are created inside the
suite's throwaway git repo.

Resolution order, and why:

1. **Manifest `version`** — first, so that if a semver is ever added later it is reported
   automatically with no further code change.
2. **SHA-named directory** — the normal installed case.
3. **`git rev-parse` on the root, suffixed `-local`** — a developer running from their own
   checkout or a local marketplace. The suffix is deliberate: that tree may carry
   uncommitted changes, so its SHA must not be conflated with the published build of the
   same name.
4. **`unknown`** — neither, e.g. an extracted tarball.

Memoised per process, so at worst one `git` call, and only in a checkout.

Accepted edge case: a checkout folder named entirely in hex (7–40 chars) would be misread
as a SHA. Not worth guarding against.

### 2. Envelope field — `logEvent()`

Add `plugin_version: pluginVersion()` to the event envelope, alongside `host`.

Every event carries it rather than `session_summary` alone, for two reasons: summaries are
absent whenever a session is killed, and putting it in the envelope makes "who is running
what right now" a single terms aggregation.

The change is purely additive, so it does not break the schema contract. Already-shipped
documents and any JSONL replayed by `telemetry-backfill.js` simply lack the field. Ship IDs
are a sha1 of the JSON line and are computed per line, so previously shipped lines keep
their IDs and idempotent retries are unaffected.

`telemetry-verify.js` does not inspect envelope identity fields and needs no change.

### 3. Grafana — new bottom row "Plugin Version"

Three panels, using bare field names in aggregations to match every existing panel, and
respecting the existing `Repo` / `Branch` / `User` template variables:

- **stat** — distinct `plugin_version` values in the window.
- **table, "Version by user"** — terms on `user` → terms on `plugin_version` (size 1,
  ordered by max `ts`) → max `ts`. One row per developer: the newest version they have
  reported and when. This is the straggler list.
- **timeseries** — document count by `plugin_version` over time, so a rollout reads as one
  curve replacing another.

To verify during implementation: if the Elasticsearch index uses explicit mappings rather
than dynamic mapping, `plugin_version` needs a `keyword` mapping added before the terms
aggregations return anything.

### 4. Tests — `test/run.js`

Unit tests of `resolvePluginVersion` against throwaway directories under `$TMPDIR`:

| Fixture | Expected |
|---|---|
| Directory named `76a8f3bfe1c4`, no manifest | `76a8f3bfe1c4` |
| Directory with `.claude-plugin/plugin.json` declaring `"version": "1.3.0"` | `1.3.0` |
| Plain directory, not hex-named, sitting inside another git repo | `unknown` |
| A git checkout | matches `/^[0-9a-f]{12,}-local$/` (`--short=12` is a minimum; git extends it to stay unambiguous) |

The manifest case is tested even though no manifest version exists today — it locks in the
future-proof path so a later semver cannot silently regress.

Plus one end-to-end assertion in the existing telemetry tests: a shipped event's
`plugin_version` is a non-empty string.

The suite stays hermetic — fixtures are built in `$TMPDIR`, no real repo and no real
Elasticsearch are touched. Reading the plugin's own git HEAD is unavoidable and harmless.

There is deliberately **no** `UK2_PLUGIN_VERSION` environment override. It would be a
spoofing surface on the one field whose entire purpose is to be trustworthy.

### 5. Documentation

- **README** — add `plugin_version` to the event-envelope paragraph, covering the SHA,
  `-local` and future-semver cases. Required by the schema-table contract.
- **CLAUDE.md** — extend the existing "deliberately has no `version` field" note to record
  that the decision is now load-bearing in a second way: the SHA-keyed cache directory is
  where telemetry reads the version from, so adding a `version` would change both update
  semantics and what this field reports.

Implementation should run through the `schema-change` skill, since it touches `logEvent()`
and the README schema table.

## Out of scope

- Any in-session or automated reminder. Reminders are manual, driven off the dashboard.
- Adding a semver to the manifest, now or as part of this change.
- Backfilling `plugin_version` onto historical events — it is unknowable retrospectively.
