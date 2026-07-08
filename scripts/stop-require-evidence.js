#!/usr/bin/env node
'use strict';
// Stop: in agent/CI mode, refuse to finish until there is passing
// verification evidence for the current HEAD. Loop-safe; capped blocks.
//
// Evidence source is configurable via .claude/validation/hooks.env (see
// hooks.env.example):
//   UK2_STOP_GATE_CMD         shell command ({root}/{head} placeholders);
//                             exit 0 counts as evidence and replaces the
//                             sentinel check; a failure's output is fed back.
//   (default)                 .claude/state/verify.json sentinel with
//                             {"passed":true,"head_commit":<HEAD>}.
// Other knobs: UK2_STOP_GATE_MESSAGE (block text, {head}/{root} placeholders),
// UK2_STOP_GATE_MAX_BLOCKS (default 3), UK2_STOP_GATE_TIMEOUT_MS (default
// 120000), UK2_STOP_GATE_DISABLE.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const c = require('./lib/common.js');

c.run((input) => {
  // Loop-safety: if we already blocked once this turn, let the stop succeed.
  if (String(c.get(input, 'stop_hook_active')) === 'true') return;
  // Only enforce in agent/CI mode — interactive local sessions end freely.
  if (!c.isAgentMode()) return;

  const src = c.hooksConfig();
  if (c.envc('STOP_GATE_DISABLE', src)) return;

  const root = c.repoRoot();
  const sid = c.get(input, 'session_id') || 'nosession';
  const head = c.gitOut(['rev-parse', 'HEAD']) || 'none';
  const fill = (s) => s.replace(/\{head\}/g, head).replace(/\{root\}/g, root);

  const verifyCmd = c.envc('STOP_GATE_CMD', src);
  let failDetail = '';
  if (verifyCmd) {
    const timeout = Number(c.envc('STOP_GATE_TIMEOUT_MS', src)) || 120000;
    try {
      execFileSync('/bin/sh', ['-c', fill(verifyCmd)], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
      });
      return; // verify command passed — evidence is in
    } catch (e) {
      if (typeof e.status !== 'number') {
        // Spawn failure / timeout kill: the command never ran to a verdict.
        process.stderr.write('uk2-claude-hooks: stop-gate verify command could not run — allowing stop (fail open)\n');
        return;
      }
      failDetail = `\n\nVerify command (${verifyCmd}) exited ${e.status}:\n`
        + c.trunc(`${e.stdout || ''}${e.stderr || ''}`, 1500);
    }
  } else {
    // Fixed path keyed by HEAD commit (not session id) so the verify step can
    // write it without knowing its own session id; freshness comes from the
    // head_commit match.
    try {
      const sentinel = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'verify.json'), 'utf8'));
      if (sentinel.passed === true && sentinel.head_commit === head) return;
    } catch { /* no sentinel */ }
  }

  // Block cap so we never loop forever.
  const maxBlocks = Number(c.envc('STOP_GATE_MAX_BLOCKS', src)) || 3;
  const capFile = path.join(root, '.claude', 'state', `stop-blocks-${sid}`);
  let blocks = 0;
  try { blocks = Number(fs.readFileSync(capFile, 'utf8')) || 0; } catch { /* first block */ }
  blocks += 1;
  try {
    fs.mkdirSync(path.dirname(capFile), { recursive: true });
    fs.writeFileSync(capFile, String(blocks));
  } catch { /* fail open */ }
  if (blocks > maxBlocks) {
    c.logEvent(input, 'stop_gate_exhausted', { blocks });
    process.stderr.write(`uk2-claude-hooks: stop-gate exhausted after ${blocks} blocks — allowing stop; a human should review.\n`);
    return;
  }

  const custom = c.envc('STOP_GATE_MESSAGE', src);
  let message;
  if (custom) {
    message = fill(custom);
  } else if (verifyCmd) {
    message = `Cannot finish: the project's stop-gate verify command has not passed for HEAD (${head}). `
      + 'Make it pass honestly before stopping. Never weaken or edit tests to go green.';
  } else {
    message = `Stage 2 cannot finish: verify-acceptance has not produced passing evidence for HEAD (${head}). `
      + 'Run verify-acceptance (or the chimera-verifier agent), confirm every acceptance criterion maps '
      + "to a real green test plus passing quality gates, and write the sentinel '.claude/state/verify.json' "
      + `({"passed":true,"head_commit":"${head}",...}). If a criterion cannot pass honestly, take the abort `
      + 'path and flag needs-human (implement-plan §5). Never weaken or edit tests to go green.';
  }
  c.block(message + failDetail);
});
