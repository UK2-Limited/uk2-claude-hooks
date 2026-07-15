'use strict';
// Shared helpers for the uk2-claude-hooks plugin. Behavioural port of the
// Chimera .claude/hooks/lib/common.sh. Fails OPEN: nothing here may ever
// crash a tool call — hooks wrap their body in run(), which swallows every
// error and exits 0.
//
// Env vars use the UK2_ prefix; the legacy CHIMERA_ prefix is honoured as a
// fallback everywhere. Config FILES are plain JSON (hooks.json / config.json,
// unprefixed camelCase keys) — the Chimera-era shell-style .env files are
// intentionally no longer read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

// envc('TELEMETRY_ES_URL') -> UK2_TELEMETRY_ES_URL, else CHIMERA_TELEMETRY_ES_URL, else ''.
function envc(key) {
  const v = process.env[`UK2_${key}`];
  if (v !== undefined && v !== '') return v;
  const legacy = process.env[`CHIMERA_${key}`];
  return legacy === undefined ? '' : legacy;
}

// hooks.json / config.json are plain JSON objects. Absent file -> {} (built-in
// defaults apply); present but unreadable/invalid -> null (callers must skip
// entirely — falling back to defaults could block on our own parse failure).
function readJsonConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  try {
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch { return null; }
}

// --- Paths ---
function repoRoot() { return process.env.CLAUDE_PROJECT_DIR || process.cwd(); }
function devenvDir() { return envc('DEVENV_DIR') || path.join(repoRoot(), '..'); }

// --- Behavioural gate config (compile-check / test-integrity / stop gate) ---
// Optional per-project JSON file, meant to be committed by the consuming repo
// (no secrets in it). Returns the parsed object ({} when absent — built-in
// defaults apply) or null when the file is present but broken (gates must
// skip). Only the *_DISABLE kill switches remain readable as env vars.
function hooksConfigFile() {
  return envc('HOOKS_CONFIG') || path.join(repoRoot(), '.claude', 'validation', 'hooks.json');
}
function hooksConfig() {
  const file = hooksConfigFile();
  const cfg = readJsonConfig(file);
  if (cfg === null) {
    process.stderr.write(`uk2-claude-hooks: invalid JSON in ${file} — gates skipped\n`);
    return null;
  }
  if (!fs.existsSync(file)) {
    const legacy = path.join(repoRoot(), '.claude', 'validation', 'hooks.env');
    if (fs.existsSync(legacy)) {
      process.stderr.write(`uk2-claude-hooks: ${legacy} is no longer read — convert it to hooks.json (see README)\n`);
    }
  }
  return cfg;
}

function relPath(p) {
  const root = repoRoot();
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

// --- stdin ---
function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

// get(input, 'tool_response.exit_code') -> value, or '' on any miss (like jq's // empty).
function get(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return '';
    cur = cur[k];
  }
  return cur === undefined || cur === null ? '' : cur;
}

function trunc(s, n = 200) { return String(s).slice(0, n); }

// --- Agent/CI mode (behavioural gates hard-block only here; warn locally) ---
function isAgentMode() {
  if (envc('AGENT_MODE')) return true;
  return ['true', 'TRUE', '1', 'yes', 'YES'].includes(process.env.CI || '');
}

// --- Decision emitters (always exit 0; the JSON carries the decision) ---
// PreToolUse hard deny — holds even under bypassPermissions.
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// PostToolUse / Stop block — feeds reason back to Claude as the next instruction.
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// --- Path matching against protected-paths.txt patterns ---
// Bash [[ == ]] glob semantics: '*' matches any run of characters INCLUDING '/'.
function globToRegex(pat) {
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

// pathMatches(<repo-relative-path>, <pattern>)
//   trailing "/"  -> directory prefix match
//   leading "**/" -> match at any depth (including repo root)
//   "*"/"**"      -> glob ("*" crosses "/")
function pathMatches(rel, pat) {
  if (pat.startsWith('**/')) {
    const rest = pat.slice(3);
    return globToRegex(rest).test(rel) || globToRegex(`*/${rest}`).test(rel);
  }
  if (pat.endsWith('/')) return rel === pat.slice(0, -1) || rel.startsWith(pat);
  return globToRegex(pat).test(rel);
}

// --- git ---
function gitOut(args, cwd = repoRoot()) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).trim();
  } catch { return ''; }
}

// --- Identity (per-developer attribution in the shared index) ---
function telemetryUser() {
  return gitOut(['config', 'user.email']) || process.env.USER || 'unknown';
}
function telemetryHost() {
  try { return os.hostname().split('.')[0] || 'unknown'; } catch { return 'unknown'; }
}
// "org/repo" from the origin remote (checkout-name agnostic, so the shared
// index aggregates across machines); folder basename when there is no remote
// or no git repo at all.
function telemetryRepo() {
  const url = gitOut(['remote', 'get-url', 'origin']);
  if (url) {
    // git@host:org/repo.git | https://host/org/repo.git | ssh://git@host:port/org/repo.git
    const m = url.replace(/\.git\/?$/, '')
      .match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^:/]+(?::\d+)?[:/](.+)$/i);
    if (m && m[1]) return m[1].replace(/^\/+/, '');
  }
  return path.basename(repoRoot());
}

function isoNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function currentIssue() {
  const fromEnv = envc('ISSUE');
  if (fromEnv) return fromEnv;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(repoRoot(), '.claude', 'state', 'ticket.json'), 'utf8'));
    return t.issue || '';
  } catch { return ''; }
}

// --- Transcript access (shared by telemetry-posttool / session-summary) ---
// Last n lines of the transcript, parsed; malformed lines are dropped
// individually so one bad line can't hide newer entries. n = Infinity reads
// the whole file.
function transcriptTail(file, n = 200) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Normalized token quad from a message.usage object. cache_creation falls back
// to the nested shape ({ephemeral_5m,ephemeral_1h}_input_tokens) when the flat
// key is absent — Anthropic sends both today, but only-nested must not read 0.
function usageTokens(u) {
  let cacheCreate = 0;
  if (typeof u.cache_creation_input_tokens === 'number') {
    cacheCreate = u.cache_creation_input_tokens;
  } else if (u.cache_creation && typeof u.cache_creation === 'object') {
    cacheCreate = (u.cache_creation.ephemeral_5m_input_tokens || 0)
      + (u.cache_creation.ephemeral_1h_input_tokens || 0);
  }
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate,
  };
}

// Sum usage across transcript entries. The transcript writes one entry PER
// CONTENT BLOCK of the same API message, each repeating the message's full
// usage (which can still grow while streaming) — so dedupe per message.id,
// last entry wins. Entries with usage but no message.id count individually
// (uuid/requestId, else a synthetic per-line key). Sidechain entries are
// inline sub-agent turns whose usage is accounted from the sub-agent's own
// transcript — skip them unless the caller IS reading a sub-agent transcript.
// turns = unique messages; model = last non-synthetic model seen (or null).
function aggregateUsage(entries, { skipSidechain = true } = {}) {
  const byMsg = new Map();
  let model = null;
  let synth = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (skipSidechain && e.isSidechain === true) continue;
    const u = e.message && e.message.usage;
    if (!u) continue;
    const key = e.message.id || e.uuid || e.requestId || `line#${synth++}`;
    byMsg.set(key, usageTokens(u));
    const m = e.message.model;
    if (m && m !== '<synthetic>') model = m;
  }
  const agg = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    turns: byMsg.size,
    model,
  };
  for (const t of byMsg.values()) {
    agg.input_tokens += t.input;
    agg.output_tokens += t.output;
    agg.cache_read_input_tokens += t.cacheRead;
    agg.cache_creation_input_tokens += t.cacheCreate;
  }
  return agg;
}

// Sum usage across every sub-agent transcript under <transcript minus
// .jsonl>/subagents/ (Task/Agent tool, Workflow fan-outs; nested arbitrarily
// deep, only *.jsonl files are read). Same per-message dedupe as
// aggregateUsage; a sub-agent transcript is its own main loop, so nothing in
// it is skipped as sidechain. Shared by session-summary and telemetry-verify
// so the two can't drift.
function sumSubagentUsage(transcriptPath) {
  const totals = { tokens: 0, cache: 0 };
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      const agg = aggregateUsage(transcriptTail(p, Infinity), { skipSidechain: false });
      totals.tokens += agg.input_tokens + agg.output_tokens;
      totals.cache += agg.cache_read_input_tokens + agg.cache_creation_input_tokens;
    }
  };
  walk(path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents'));
  return totals;
}

// --- Telemetry (append-only JSONL, never blocks) ---
function shipConfigFile() {
  return envc('TELEMETRY_CONFIG') || path.join(repoRoot(), '.claude', 'telemetry', 'config.json');
}
function shipSpoolFile() {
  return envc('TELEMETRY_SPOOL') || path.join(repoRoot(), '.claude', 'telemetry', 'unshipped.jsonl');
}

// logEvent(input, <event-type>, <extra-fields>)
function logEvent(input, event, extra = {}) {
  try {
    const sid = get(input, 'session_id') || 'nosession';
    const issue = currentIssue();
    // agent_id is present in the hook payload only when the call was made by a
    // sub-agent (Task/Agent tool, Workflow fan-outs); session_id stays the parent's.
    const agentId = get(input, 'agent_id') || null;
    const line = JSON.stringify({
      ts: isoNow(),
      event,
      session_id: sid,
      branch: gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
      repo: telemetryRepo(),
      user: telemetryUser(),
      host: telemetryHost(),
      issue: issue || null,
      subagent: Boolean(agentId),
      agent_id: agentId,
      ...extra,
    });
    const dir = path.join(repoRoot(), '.claude', 'telemetry', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    // Single-line O_APPEND writes at this size are atomic — no lock needed.
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), `${line}\n`);
    shipEvent(line);
  } catch { /* telemetry must never block the agent */ }
}

// --- Real-time shipping to Elasticsearch (fire-and-forget, fail-open) ---
// Config lives OUTSIDE git (<project>/.claude/telemetry/ is gitignored by the
// consuming repo); an absent file silently disables shipping. The network work
// happens in a detached child process (lib/ship.js) so a slow or unreachable
// ES never delays a tool call.
function shipEvent(line) {
  try {
    if (envc('TELEMETRY_DISABLE')) return;
    if (!fs.existsSync(shipConfigFile())) {
      const legacy = path.join(repoRoot(), '.claude', 'telemetry', 'config.env');
      if (fs.existsSync(legacy)) {
        process.stderr.write(`uk2-claude-hooks: ${legacy} is no longer read — convert it to config.json (see README)\n`);
      }
      return;
    }
    spawn(process.execPath, [path.join(__dirname, 'ship.js'), line], {
      detached: true, stdio: 'ignore', cwd: repoRoot(),
    }).unref();
  } catch { /* fire-and-forget */ }
}

// --- Hook entry point: fail open, always exit 0 unless deny/block exited first ---
function run(fn) {
  Promise.resolve()
    .then(() => fn(readInput()))
    .catch(() => {})
    .then(() => process.exit(0));
}

module.exports = {
  envc, readJsonConfig, repoRoot, devenvDir, hooksConfigFile, hooksConfig,
  relPath, readInput, get, trunc, isAgentMode,
  deny, block, pathMatches, gitOut, telemetryUser, telemetryHost, telemetryRepo, isoNow,
  currentIssue, transcriptTail, usageTokens, aggregateUsage, sumSubagentUsage,
  shipConfigFile, shipSpoolFile, logEvent,
  shipEvent, run,
};
