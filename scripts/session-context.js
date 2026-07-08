#!/usr/bin/env node
'use strict';
// SessionStart: inject the issue number + acceptance criteria + stay-in-scope
// reminder when a ticket context (<project>/.claude/state/ticket.json) is
// present. Also records session start for the SessionEnd summary. Injects
// nothing in a plain local session.

const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');

c.run((input) => {
  const root = c.repoRoot();
  const sid = c.get(input, 'session_id') || 'nosession';
  const branch = c.gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';

  let issue = c.envc('ISSUE');
  let criteria = '';
  let outOfScope = '';
  try {
    const ticket = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'ticket.json'), 'utf8'));
    if (!issue) issue = String(ticket.issue || '');
    criteria = (ticket.acceptance_criteria || []).map((x) => `  - ${x}`).join('\n');
    outOfScope = String(ticket.out_of_scope || '');
  } catch { /* no ticket context */ }

  // Record session start (wall-time baseline for the SessionEnd summary).
  try {
    fs.mkdirSync(path.join(root, '.claude', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'state', `session-${sid}.json`),
      `${JSON.stringify({ start_ts: c.isoNow(), issue: issue || null, branch })}\n`,
    );
  } catch { /* fail open */ }

  // Nothing to inject without a ticket context.
  if (!issue && !criteria) return;

  const ctx = `Automation context for this session:
Issue: #${issue || 'unknown'}   Branch: ${branch}

Acceptance criteria (held-out — satisfy them, never edit them to go green):
${criteria || '  (none provided)'}
${outOfScope ? `\nOut of scope: ${outOfScope}` : ''}
Stay strictly in scope — implement only what the plan named. Tests run in the dev
container (see the dev-container / test-execution skills). Do not weaken pre-existing
tests; if a criterion cannot pass honestly, use the abort path and flag needs-human.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
});
