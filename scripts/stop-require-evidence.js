#!/usr/bin/env node
'use strict';
// Stop: in agent/CI mode, refuse to finish until verify-acceptance produced a
// passing evidence sentinel for the current HEAD. Loop-safe; capped at 3 blocks.

const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');

c.run((input) => {
  // Loop-safety: if we already blocked once this turn, let the stop succeed.
  if (String(c.get(input, 'stop_hook_active')) === 'true') return;
  // Only enforce in agent/CI mode — interactive local sessions end freely.
  if (!c.isAgentMode()) return;

  const root = c.repoRoot();
  const sid = c.get(input, 'session_id') || 'nosession';
  const head = c.gitOut(['rev-parse', 'HEAD']) || 'none';

  // Fixed path keyed by HEAD commit (not session id) so the verify step can
  // write it without knowing its own session id; freshness comes from the
  // head_commit match.
  try {
    const sentinel = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'verify.json'), 'utf8'));
    if (sentinel.passed === true && sentinel.head_commit === head) return;
  } catch { /* no sentinel */ }

  // Block cap so we never loop forever.
  const capFile = path.join(root, '.claude', 'state', `stop-blocks-${sid}`);
  let blocks = 0;
  try { blocks = Number(fs.readFileSync(capFile, 'utf8')) || 0; } catch { /* first block */ }
  blocks += 1;
  try {
    fs.mkdirSync(path.dirname(capFile), { recursive: true });
    fs.writeFileSync(capFile, String(blocks));
  } catch { /* fail open */ }
  if (blocks > 3) {
    c.logEvent(input, 'stop_gate_exhausted', { blocks });
    process.stderr.write(`uk2-claude-hooks: stop-gate exhausted after ${blocks} blocks — allowing stop; a human should review.\n`);
    return;
  }

  c.block(`Stage 2 cannot finish: verify-acceptance has not produced passing evidence for HEAD (${head}). `
    + 'Run verify-acceptance (or the chimera-verifier agent), confirm every acceptance criterion maps '
    + "to a real green test plus passing quality gates, and write the sentinel '.claude/state/verify.json' "
    + `({"passed":true,"head_commit":"${head}",...}). If a criterion cannot pass honestly, take the abort `
    + 'path and flag needs-human (implement-plan §5). Never weaken or edit tests to go green.');
});
