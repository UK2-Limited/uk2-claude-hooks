#!/usr/bin/env node
'use strict';
// SessionEnd: per-ticket telemetry roll-up. Sums token usage from the
// transcript, computes wall time, counts test runs / failures from this
// session's JSONL, and appends a `session_summary` line to both the
// per-session file and summaries.jsonl. Ships in the FOREGROUND — SessionEnd
// is not latency sensitive and a detached child could be reaped as Claude
// Code exits (bounded by the fetch timeouts).

const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');
const ship = require('./lib/ship.js');

function countEvents(text, event) {
  return text.split('\n').filter((l) => l.includes(`"event":"${event}"`)).length;
}

c.run(async (input) => {
  const root = c.repoRoot();
  const sid = c.get(input, 'session_id') || 'nosession';
  const transcript = String(c.get(input, 'transcript_path') || '');
  const endReason = c.get(input, 'end_reason');
  const branch = c.gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const issue = c.currentIssue();

  const tok = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    turns: 0,
    est_cost_usd: 0,
  };
  if (transcript) {
    try {
      let cost = 0;
      for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const usage = entry && entry.message && entry.message.usage;
        if (usage) {
          tok.input_tokens += usage.input_tokens || 0;
          tok.output_tokens += usage.output_tokens || 0;
          tok.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
          tok.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
          tok.turns += 1;
        }
        const lineCost = entry && (entry.costUSD ?? entry.total_cost_usd);
        if (typeof lineCost === 'number' && lineCost > cost) cost = lineCost;
      }
      tok.total_tokens = tok.input_tokens + tok.output_tokens
        + tok.cache_read_input_tokens + tok.cache_creation_input_tokens;
      tok.est_cost_usd = cost;
    } catch { /* unreadable transcript -> zeros */ }
  }

  // Wall time from the SessionStart baseline (fallback: null).
  let wallMs = null;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', `session-${sid}.json`), 'utf8'));
    const start = Date.parse(state.start_ts);
    if (!Number.isNaN(start)) wallMs = Math.floor((Date.now() - start) / 1000) * 1000;
  } catch { /* no baseline */ }

  // Counts from this session's own telemetry file.
  const sessionFile = path.join(root, '.claude', 'telemetry', 'sessions', `${sid}.jsonl`);
  let events = '';
  try { events = fs.readFileSync(sessionFile, 'utf8'); } catch { /* none yet */ }

  const summary = JSON.stringify({
    ts: c.isoNow(),
    event: 'session_summary',
    session_id: sid,
    branch,
    repo: c.telemetryRepo(),
    user: c.telemetryUser(),
    host: c.telemetryHost(),
    issue: issue || null,
    end_reason: endReason || null,
    wall_ms: wallMs,
    tests_run: countEvents(events, 'test_run'),
    tool_failures: countEvents(events, 'tool_failure'),
    compile_fails: countEvents(events, 'compile_fail'),
    tool_calls: countEvents(events, 'tool_use'),
    ...tok,
  });

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.appendFileSync(sessionFile, `${summary}\n`);
  fs.appendFileSync(path.join(root, '.claude', 'telemetry', 'summaries.jsonl'), `${summary}\n`);

  const cfg = ship.loadShipConfig();
  if (cfg) {
    if (!(await ship.shipOne(cfg, summary))) ship.spoolLine(summary);
    await ship.flushSpool(cfg, 500);
  }
});
