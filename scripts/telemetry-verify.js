#!/usr/bin/env node
'use strict';
// One-off CLI (not a hook): cross-check the telemetry accumulated under
// <project>/.claude/telemetry/ against the actual Claude Code session
// transcripts and report discrepancies. Strictly READ-ONLY — never writes,
// never ships. Because it recomputes with the same aggregateUsage /
// sumSubagentUsage helpers the hooks use, it catches missed or stale events
// and historically inflated summaries, not bugs inside the aggregation
// itself.
//
//   node telemetry-verify.js [project-root] [--session <id>]
//                            [--projects-dir <dir>] [--json]
//
// Transcripts are looked up in --projects-dir, defaulting to Claude Code's
// store: ~/.claude/projects/<project path with [/._] flattened to '-'>/.
// A session whose transcript is gone (Claude Code prunes them) is a skip,
// not a failure. Summaries written before the 2026-07 dedupe fix will
// legitimately report inflated token fields — check the summary's ts.
//
// Exit codes: 0 = clean (or only skips), 1 = discrepancies found, 2 = usage
// or config error.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Parse argv before loading common.js — the positional root must land in
// CLAUDE_PROJECT_DIR so the shared path helpers point at the target project.
const opts = { root: '', session: '', projectsDir: '', json: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--session') opts.session = argv[(i += 1)] || '';
    else if (a === '--projects-dir') opts.projectsDir = argv[(i += 1)] || '';
    else if (!a.startsWith('--') && !opts.root) opts.root = a;
    else {
      process.stderr.write(`unknown argument: ${a}\n`
        + 'usage: telemetry-verify.js [project-root] [--session <id>] [--projects-dir <dir>] [--json]\n');
      process.exit(2);
    }
  }
}
process.env.CLAUDE_PROJECT_DIR = path.resolve(opts.root || process.cwd());

const c = require('./lib/common.js');
const ship = require('./lib/ship.js');

const ROOT = c.repoRoot();
const TELE = path.join(ROOT, '.claude', 'telemetry');

// Claude Code flattens the project path into one directory name.
function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[/._]/g, '-'));
}

// Find <sid>.jsonl: the flattened dir first, then any project dir (the exact
// flattening rule is undocumented, so don't make it critical).
function findTranscript(sid) {
  const primary = path.join(opts.projectsDir || defaultProjectsDir(), `${sid}.jsonl`);
  if (fs.existsSync(primary)) return primary;
  if (opts.projectsDir) return '';
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(base); } catch { return ''; }
  for (const d of dirs) {
    const p = path.join(base, d, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function parseEvents(lines) {
  const events = [];
  let corrupt = 0;
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { corrupt += 1; }
  }
  return { events, corrupt };
}

const checks = []; // {name, session, status: ok|mismatch|skip|info, detail}
function report(name, session, status, detail) {
  checks.push({ name, session, status, detail });
}

// --- Check 1+2: per-session summary recompute + tool_use invariants ---
function verifySession(sid, file) {
  const lines = readLines(file);
  const { events, corrupt } = parseEvents(lines);
  if (corrupt) report('corrupt-lines', sid, 'mismatch', `${corrupt} unparseable line(s) in ${path.basename(file)}`);

  const summaries = events.filter((e) => e.event === 'session_summary');
  const toolUses = events.filter((e) => e.event === 'tool_use');

  // tool_use invariants (informational unless structurally wrong).
  if (toolUses.length) {
    const nullIds = toolUses.filter((e) => !e.message_id).length;
    const byMsg = new Map();
    let raw = 0;
    for (const e of toolUses) {
      raw += e.tokens_out || 0;
      if (e.message_id) byMsg.set(e.message_id, e.tokens_out || 0);
    }
    let deduped = 0;
    for (const v of byMsg.values()) deduped += v;
    report('tool_use', sid, 'info',
      `${toolUses.length} events, ${nullIds} without message_id; `
      + `tokens_out raw-sum ${raw} vs message-deduped ${deduped} (README: dedupe on message_id)`);
  }

  if (!summaries.length) {
    report('summary-recompute', sid, 'skip', 'no session_summary event (session still open or killed)');
    return;
  }
  // Multiple SessionEnds (resumed sessions) append multiple summaries; the
  // last one reflects the final state.
  const summary = summaries[summaries.length - 1];

  // tool_calls counts the tool_use lines present when the summary was written.
  const lastSummaryIdx = events.lastIndexOf(summary);
  const toolUsesBefore = events.slice(0, lastSummaryIdx).filter((e) => e.event === 'tool_use').length;
  if (summary.tool_calls !== toolUsesBefore) {
    report('tool-calls-count', sid, 'mismatch',
      `summary says tool_calls=${summary.tool_calls}, session file has ${toolUsesBefore} tool_use before it`);
  }

  const transcript = findTranscript(sid);
  if (!transcript) {
    report('summary-recompute', sid, 'skip', 'transcript not found (pruned or other machine)');
    return;
  }

  const entries = c.transcriptTail(transcript, Infinity);
  const agg = c.aggregateUsage(entries);
  const sub = c.sumSubagentUsage(transcript);
  const expect = {
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    cache_read_input_tokens: agg.cache_read_input_tokens,
    cache_creation_input_tokens: agg.cache_creation_input_tokens,
    total_subagent_tokens: sub.tokens,
    total_subagent_cache_tokens: sub.cache,
    total_tokens: agg.input_tokens + agg.output_tokens + sub.tokens,
    total_cache_tokens: agg.cache_read_input_tokens + agg.cache_creation_input_tokens + sub.cache,
    turns: agg.turns,
    model: agg.model,
  };
  const bad = [];
  for (const [k, v] of Object.entries(expect)) {
    if (!(k in summary)) continue; // pre-`model` summaries
    if (summary[k] !== v) bad.push(`${k}: logged ${summary[k]}, transcript says ${v}`);
  }
  if (bad.length) {
    report('summary-recompute', sid, 'mismatch',
      `summary ts=${summary.ts} (pre-2026-07 summaries are inflated by design): ${bad.join('; ')}`);
  } else {
    report('summary-recompute', sid, 'ok', 'all token fields match the transcript');
  }

  // tool_use message_ids should exist in the transcript we just read.
  const known = new Set();
  for (const e of entries) {
    if (e.message && e.message.id) known.add(e.message.id);
  }
  const orphans = new Set();
  for (const e of toolUses) {
    // Sub-agent calls reference messages in their own transcripts.
    if (e.message_id && !e.subagent && !known.has(e.message_id)) orphans.add(e.message_id);
  }
  if (orphans.size) {
    report('tool_use-orphans', sid, 'mismatch',
      `${orphans.size} main-loop message_id(s) not in the transcript: ${[...orphans].slice(0, 3).join(', ')}…`);
  }
}

// --- Check 3: sessions/*.jsonl summaries <-> summaries.jsonl ---
function verifySummariesFile(sessionFiles) {
  const sha = (l) => crypto.createHash('sha1').update(l).digest('hex');
  const inSummaries = new Set(readLines(path.join(TELE, 'summaries.jsonl'))
    .filter((l) => l.includes('"event":"session_summary"')).map(sha));
  const inSessions = new Set();
  for (const f of sessionFiles) {
    for (const l of readLines(f)) {
      if (l.includes('"event":"session_summary"')) inSessions.add(sha(l));
    }
  }
  const missing = [...inSessions].filter((h) => !inSummaries.has(h)).length;
  const extra = [...inSummaries].filter((h) => !inSessions.has(h)).length;
  if (missing || extra) {
    report('summaries-consistency', null, 'mismatch',
      `${missing} summary line(s) missing from summaries.jsonl, ${extra} in summaries.jsonl `
      + 'with no session file (same sha1 identity the shipper uses)');
  } else {
    report('summaries-consistency', null, 'ok',
      `${inSessions.size} summary line(s) present in both places`);
  }
}

// --- Check 4-6: spool health, corrupt summaries, shipping config ---
function verifyHealth() {
  const spool = c.shipSpoolFile();
  const spoolLines = readLines(spool);
  if (spoolLines.length) {
    let oldest = '';
    try { oldest = JSON.parse(spoolLines[0]).ts || ''; } catch { /* reported below */ }
    report('spool', null, 'info',
      `${spoolLines.length} unshipped event(s) in ${path.basename(spool)}`
      + (oldest ? `, oldest ts=${oldest}` : ''));
    const corrupt = parseEvents(spoolLines).corrupt;
    if (corrupt) report('spool', null, 'mismatch', `${corrupt} unparseable spool line(s)`);
  }
  const corrupt = parseEvents(readLines(path.join(TELE, 'summaries.jsonl'))).corrupt;
  if (corrupt) report('corrupt-lines', null, 'mismatch', `${corrupt} unparseable line(s) in summaries.jsonl`);
  report('shipping', null, 'info',
    ship.loadShipConfig() ? 'shipping configured' : 'shipping not configured (local JSONL only)');
}

function main() {
  const sessionsDir = path.join(TELE, 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(sessionsDir, f));
  } catch { /* no telemetry yet */ }
  if (opts.session) files = files.filter((f) => path.basename(f, '.jsonl') === opts.session);
  if (!files.length) {
    process.stderr.write(`no telemetry session files under ${sessionsDir}`
      + (opts.session ? ` for session ${opts.session}` : '') + '\n');
    process.exit(2);
  }

  for (const f of files.sort()) verifySession(path.basename(f, '.jsonl'), f);
  if (!opts.session) verifySummariesFile(files);
  verifyHealth();

  const counts = { ok: 0, mismatch: 0, skip: 0, info: 0 };
  for (const chk of checks) counts[chk.status] += 1;
  const exit = counts.mismatch ? 1 : 0;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ project: ROOT, checks, counts, exit }, null, 2)}\n`);
  } else {
    for (const chk of checks) {
      const where = chk.session ? ` [${chk.session}]` : '';
      process.stdout.write(`${chk.status.padEnd(8)} ${chk.name}${where}: ${chk.detail}\n`);
    }
    process.stdout.write(`\nRESULT: ${counts.ok} ok, ${counts.mismatch} mismatch, `
      + `${counts.skip} skipped, ${counts.info} info\n`);
  }
  process.exit(exit);
}

main();
