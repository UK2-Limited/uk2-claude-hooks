#!/usr/bin/env node
'use strict';
// SessionEnd: per-ticket telemetry roll-up. Sums token usage from the
// transcript (plus sub-agent transcripts under <transcript>/subagents/),
// computes wall time, counts test runs / failures from this
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
    total_subagent_tokens: 0,
    total_subagent_cache_tokens: 0,
    total_tokens: 0,
    total_cache_tokens: 0,
    turns: 0,
    // Last main-loop assistant model — a label for downstream cost estimation;
    // mixed-model sessions should cost from tool_use events instead.
    model: null,
  };
  if (transcript) {
    try {
      // Whole transcript, parsed. aggregateUsage dedupes per message.id (the
      // transcript repeats a message's full usage once per content block) and
      // skips inline sidechain turns — their usage is summed from the
      // sub-agent transcripts below.
      const entries = c.transcriptTail(transcript, Infinity);
      const agg = c.aggregateUsage(entries);
      tok.input_tokens = agg.input_tokens;
      tok.output_tokens = agg.output_tokens;
      tok.cache_read_input_tokens = agg.cache_read_input_tokens;
      tok.cache_creation_input_tokens = agg.cache_creation_input_tokens;
      tok.turns = agg.turns;
      tok.model = agg.model || null;
    } catch { /* unreadable transcript -> zeros */ }

    // Sub-agent transcripts (Task/Agent tool, Workflow fan-outs) live under
    // <transcript-path minus .jsonl>/subagents/, nested arbitrarily deep. Their
    // usage never appears in the main transcript, so sum it separately here.
    const sub = c.sumSubagentUsage(transcript);
    tok.total_subagent_tokens = sub.tokens;
    tok.total_subagent_cache_tokens = sub.cache;

    tok.total_tokens = tok.input_tokens + tok.output_tokens + tok.total_subagent_tokens;
    tok.total_cache_tokens = tok.cache_creation_input_tokens + tok.cache_read_input_tokens
      + tok.total_subagent_cache_tokens;
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
    subagent: false,
    agent_id: null,
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
