#!/usr/bin/env node
'use strict';
// PostToolUse (*): telemetry. Emits a `tool_use` line for every tool call
// (with the issuing message's token usage), a `test_run` line for every test
// invocation, a `tool_failure` line for any tool that errored, a `skill_use`
// line naming each skill invoked via the Skill tool, an `agent_use` line
// naming each subagent type spawned via the Agent tool, and an `edit` line
// with lines added/removed for every successful file-modifying call.
// Never blocks (exit 0).

const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');
const { splitCommand } = require('./lib/cmdsplit.js');

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

// The sub-agent's own transcript: directly under subagents/, or nested deeper
// for Workflow fan-outs. '' when it cannot be found.
function findAgentTranscript(transcript, agentId) {
  if (!transcript) return '';
  const name = `agent-${agentId}.jsonl`;
  const root = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const direct = path.join(root, name);
  try { fs.accessSync(direct); return direct; } catch { /* walk instead */ }
  const stack = [root];
  while (stack.length) {
    let entries;
    const dir = stack.pop();
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.name === name) return path.join(dir, e.name);
    }
  }
  return '';
}

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  if (!tool) return;
  const exitCode = c.get(input, 'tool_response.exit_code');
  // Commands are logged with user-specific path prefixes stripped (cwd ->
  // relative, $HOME -> ~) so identical commands aggregate across checkouts.
  const cmd = c.relCmd(String(c.get(input, 'tool_input.command') || ''), input);

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

  // File-path tools (Read/Edit/Write/MultiEdit/NotebookEdit) carry the target
  // file; when it lives in a first-level subfolder repo of the session root
  // (multi-repo workspace), the event is attributed to THAT repo/branch and
  // file_path is relative to it. Otherwise: session attribution, path
  // normalized like commands (cwd/repo-root stripped, $HOME -> ~).
  const filePath = String(c.get(input, 'tool_input.file_path') || c.get(input, 'tool_input.notebook_path') || '');
  const fInfo = filePath ? c.gitInfoFor(filePath) : null;
  const fileOpts = filePath ? { attributePath: filePath } : {};

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
    }, fileOpts);
  }

  // --- tool_use: one line per tool call, for usage stats ---
  // Token counts come from the transcript's last assistant message (the one
  // that issued this call) — usage is per MESSAGE, so parallel tool calls in
  // one message share the same numbers; dedupe on message_id when summing.
  // Sub-agent calls carry the PARENT's transcript_path plus an agent_id; their
  // own messages live in <transcript minus .jsonl>/subagents/**/agent-<id>.jsonl,
  // so read that file instead (an unfindable one logs null tokens rather than
  // misattributing the main loop's numbers).
  const transcript = String(c.get(input, 'transcript_path') || '');
  const agentId = String(c.get(input, 'agent_id') || '');
  const usageFile = agentId ? findAgentTranscript(transcript, agentId) : transcript;
  let entries = usageFile ? c.transcriptTail(usageFile) : [];
  // The main transcript can inline sub-agent (sidechain) turns; their usage
  // belongs to the sub-agent, not this call — drop them so neither the token
  // pick nor the session-model inference below latches onto one. A sub-agent's
  // own transcript is its own main loop, so nothing is dropped there.
  if (!agentId) entries = entries.filter((e) => e.isSidechain !== true);
  let usage = {};
  let msgId = '';
  let msgModel = '';
  for (const e of entries) {
    const u = e.message && e.message.usage;
    if (u) {
      msgId = e.message.id || '';
      const m = e.message.model;
      if (m && m !== '<synthetic>') msgModel = m;
      const t = c.usageTokens(u);
      usage = {
        tokens_in: t.input,
        tokens_out: t.output,
        tokens_cache_read: t.cacheRead,
        tokens_cache_created: t.cacheCreate,
      };
    }
  }
  const ok = !failed;
  // Chained commands additionally ship split for aggregation: segments (the
  // chain cut at top-level ;/&&/||/newlines) and per-pipeline-stage program
  // names — computed from the untruncated normalized command, so segments
  // past the 200-char `command` cutoff survive. Best effort: a parser error
  // omits the arrays, never the event.
  let split = null;
  if (tool === 'Bash' && cmd) {
    try { split = splitCommand(cmd); } catch { split = null; }
  }
  c.logEvent(input, 'tool_use', {
    tool, ok, message_id: msgId || null, model: msgModel || null,
    ...(tool === 'Bash' && cmd ? { command: c.trunc(cmd, 200) } : {}),
    ...(split && split.segments.length ? { command_segments: split.segments } : {}),
    ...(split && split.programs.length ? { command_programs: split.programs } : {}),
    ...(filePath ? { file_path: c.trunc(fInfo ? fInfo.relPath : c.relCmd(filePath, input), 300) } : {}),
    ...usage,
  }, fileOpts);

  // --- skill_use: which skill was invoked (Skill tool carries the name) ---
  if (tool === 'Skill') {
    const skill = String(c.get(input, 'tool_input.skill') || 'unknown');
    const args = String(c.get(input, 'tool_input.args') || '');
    c.logEvent(input, 'skill_use', { skill, args: args || null, ok });
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
      // Joins the spawn to the worker's own events (their agent_id).
      spawned_agent_id: c.get(input, 'tool_response.agentId') || null,
      ok,
      // Full task instruction given to the subagent — ships untruncated.
      prompt: String(c.get(input, 'tool_input.prompt') || '') || null,
    });
  }

  // --- edit: lines of code accepted, per successful file-modifying call ---
  // Counts come from the tool_response's structuredPatch (exact, handles
  // replace_all); null when the patch is absent or malformed (NotebookEdit,
  // older Claude Code versions) — never guessed from tool_input arithmetic.
  // Exception: a Write that CREATES a file ships an empty structuredPatch
  // ({type:'create', content, originalFile:null}), so lines come from the
  // accepted content instead.
  if (ok && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    if (filePath) {
      let linesAdded = null;
      let linesRemoved = null;
      const patch = c.get(input, 'tool_response.structuredPatch');
      if (Array.isArray(patch)) {
        linesAdded = 0;
        linesRemoved = 0;
        for (const hunk of patch) {
          for (const l of Array.isArray(hunk && hunk.lines) ? hunk.lines : []) {
            if (typeof l !== 'string') continue;
            if (l[0] === '+') linesAdded += 1;
            else if (l[0] === '-') linesRemoved += 1;
          }
        }
        const content = c.get(input, 'tool_response.content');
        if (patch.length === 0 && c.get(input, 'tool_response.type') === 'create'
            && typeof content === 'string' && content !== '') {
          linesAdded = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
        }
      }
      c.logEvent(input, 'edit', {
        tool,
        file_path: fInfo ? fInfo.relPath : c.relPath(filePath),
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        permission_mode: c.get(input, 'permission_mode') || null,
      }, fileOpts);
    }
  }
});
