#!/usr/bin/env node
'use strict';
// PostToolUse (*): telemetry. Emits a `tool_use` line for every tool call
// (with the issuing message's token usage), a `test_run` line for every test
// invocation, a `tool_failure` line for any tool that errored, a `skill_use`
// line naming each skill invoked via the Skill tool, and an `agent_use` line
// naming each subagent type spawned via the Agent tool. Never blocks (exit 0).

const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');

// model: value from an agent definition's YAML frontmatter, '' when absent.
function frontmatterModel(file) {
  try {
    let inFrontmatter = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^---\s*$/.test(line)) {
        if (inFrontmatter) return '';
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        const m = line.match(/^model:\s*(\S+)/);
        if (m) return m[1];
      }
    }
  } catch { /* no def file */ }
  return '';
}

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  if (!tool) return;
  const exitCode = c.get(input, 'tool_response.exit_code');
  const cmd = String(c.get(input, 'tool_input.command') || '');

  // --- test_run: scripts/test_this or a bare `prove` invocation ---
  if (tool === 'Bash' && /(test_this|(^|\s)prove(\s|$))/.test(cmd)) {
    const combined = `${c.get(input, 'tool_response.stdout')}\n${c.get(input, 'tool_response.stderr')}`;
    const target = (cmd.match(/(Chimera::[A-Za-z0-9_:]+|[A-Za-z0-9_./-]+\.t)/) || [])[1] || 'unknown';
    const totalM = combined.match(/Tests=(\d+)/);
    const wallM = combined.match(/(\d+(?:\.\d+)?) wallclock secs/);
    c.logEvent(input, 'test_run', {
      command: c.trunc(cmd, 300),
      target,
      exit_code: exitCode === '' ? null : exitCode,
      passed: (combined.match(/^ok \d+/gm) || []).length,
      failed: (combined.match(/^not ok \d+/gm) || []).length,
      tests_run: totalM ? Number(totalM[1]) : null,
      duration_ms: wallM ? Math.floor(Number(wallM[1]) * 1000) : null,
    });
  }

  // --- tool_failure: any non-zero Bash, or an error response on another tool ---
  let failed = false;
  if (exitCode !== '' && Number(exitCode) !== 0) failed = true;
  const err = c.get(input, 'tool_response.error') || c.get(input, 'error');
  if (err) failed = true;

  if (failed) {
    const errsum = String(c.get(input, 'tool_response.stderr') || (typeof err === 'object' ? JSON.stringify(err) : err) || '').split('\n')[0];
    c.logEvent(input, 'tool_failure', {
      tool,
      exit_code: exitCode === '' ? null : exitCode,
      command: c.trunc(cmd, 200),
      error_summary: c.trunc(errsum, 300),
    });
  }

  // --- tool_use: one line per tool call, for usage stats ---
  // Token counts come from the transcript's last assistant message (the one
  // that issued this call) — usage is per MESSAGE, so parallel tool calls in
  // one message share the same numbers; dedupe on message_id when summing.
  const transcript = String(c.get(input, 'transcript_path') || '');
  const entries = transcript ? c.transcriptTail(transcript) : [];
  let usage = {};
  let msgId = '';
  for (const e of entries) {
    const u = e.message && e.message.usage;
    if (u) {
      msgId = e.message.id || '';
      usage = {
        tokens_in: u.input_tokens || 0,
        tokens_out: u.output_tokens || 0,
        tokens_cache_read: u.cache_read_input_tokens || 0,
        tokens_cache_created: u.cache_creation_input_tokens || 0,
      };
    }
  }
  const ok = !failed;
  c.logEvent(input, 'tool_use', { tool, ok, message_id: msgId || null, ...usage });

  // --- skill_use: which skill was invoked (Skill tool carries the name) ---
  if (tool === 'Skill') {
    const skill = String(c.get(input, 'tool_input.skill') || 'unknown');
    const args = String(c.get(input, 'tool_input.args') || '');
    c.logEvent(input, 'skill_use', { skill, args: args ? c.trunc(args, 200) : null, ok });
  }

  // --- agent_use: which subagent type was spawned (Agent tool, aka Task) ---
  // The payload only carries an explicit model override; resolve the effective
  // model as override > agent-definition frontmatter > session model (last
  // assistant message in the transcript).
  if (tool === 'Agent' || tool === 'Task') {
    const agentType = String(c.get(input, 'tool_input.subagent_type') || '');
    let model = String(c.get(input, 'tool_input.model') || '');
    let modelSource = model ? 'override' : '';
    if (!model && agentType && !/[\\/]|\.\./.test(agentType)) {
      const fm = frontmatterModel(path.join(c.repoRoot(), '.claude', 'agents', `${agentType}.md`));
      if (fm && fm !== 'inherit') {
        model = fm;
        modelSource = 'agent-def';
      }
    }
    if (!model) {
      for (const e of entries) {
        const m = e.message && e.message.model;
        if (m && m !== '<synthetic>') model = m;
      }
      if (model) modelSource = 'session';
    }
    c.logEvent(input, 'agent_use', {
      agent_type: agentType || 'general-purpose',
      description: c.trunc(String(c.get(input, 'tool_input.description') || ''), 200),
      model: model || null,
      model_source: modelSource || null,
      ok,
    });
  }
});
