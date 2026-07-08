#!/usr/bin/env node
'use strict';
// Stop: in agent/CI mode, refuse to finish until there is passing
// verification evidence for the current HEAD. Loop-safe; capped blocks.
//
// Evidence source is configurable via the stopGate block in
// .claude/validation/hooks.json (see hooks.json.example):
//   cmds        array of shell commands ({root}/{head} placeholders), run in
//               order; ALL must exit 0 to count as evidence (replaces the
//               sentinel check). The first failure's output is fed back and
//               the remaining commands are not run.
//   (default)   .claude/state/verify.json sentinel with
//               {"passed":true,"head_commit":<HEAD>}.
// Other knobs: message (block text, {head}/{root} placeholders), maxBlocks
// (default 3), timeoutMs (per command, default 120000), disable (the
// UK2_STOP_GATE_DISABLE env var also works).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const c = require('./lib/common.js');

c.run((input) => {
  // Loop-safety: if we already blocked once this turn, let the stop succeed.
  if (String(c.get(input, 'stop_hook_active')) === 'true') return;
  // Only enforce in agent/CI mode — interactive local sessions end freely.
  if (!c.isAgentMode()) return;

  const cfg = c.hooksConfig();
  if (cfg === null) return; // broken hooks.json — fail open, never block
  const sg = cfg.stopGate || {};
  if (sg.disable || c.envc('STOP_GATE_DISABLE')) return;

  const root = c.repoRoot();
  const sid = c.get(input, 'session_id') || 'nosession';
  const head = c.gitOut(['rev-parse', 'HEAD']) || 'none';
  const fill = (s) => s.replace(/\{head\}/g, head).replace(/\{root\}/g, root);

  // A bare string is tolerated and treated as a one-command list.
  const cmds = (typeof sg.cmds === 'string' ? [sg.cmds] : Array.isArray(sg.cmds) ? sg.cmds : [])
    .filter((s) => typeof s === 'string' && s);
  let failDetail = '';
  if (cmds.length) {
    const timeout = Number(sg.timeoutMs) || 120000;
    let failed = null;
    for (const cmd of cmds) {
      try {
        execFileSync('/bin/sh', ['-c', fill(cmd)], {
          cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
        });
      } catch (e) {
        if (typeof e.status !== 'number') {
          // Spawn failure / timeout kill: the command never ran to a verdict.
          process.stderr.write('uk2-claude-hooks: stop-gate verify command could not run — allowing stop (fail open)\n');
          return;
        }
        failed = { cmd, status: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
        break; // feed back one failure at a time; later commands are not run
      }
    }
    if (!failed) return; // every verify command passed — evidence is in
    failDetail = `\n\nVerify command (${failed.cmd}) exited ${failed.status}:\n`
      + c.trunc(failed.out, 1500);
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
  const maxBlocks = Number(sg.maxBlocks) || 3;
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

  const custom = typeof sg.message === 'string' ? sg.message : '';
  let message;
  if (custom) {
    message = fill(custom);
  } else if (cmds.length) {
    message = `Cannot finish: the project's stop-gate verify commands have not all passed for HEAD (${head}). `
      + 'Make them pass honestly before stopping. Never weaken or edit tests to go green.';
  } else {
    message = `Stage 2 cannot finish: verify-acceptance has not produced passing evidence for HEAD (${head}). `
      + 'Run verify-acceptance (or the chimera-verifier agent), confirm every acceptance criterion maps '
      + "to a real green test plus passing quality gates, and write the sentinel '.claude/state/verify.json' "
      + `({"passed":true,"head_commit":"${head}",...}). If a criterion cannot pass honestly, take the abort `
      + 'path and flag needs-human (implement-plan §5). Never weaken or edit tests to go green.';
  }
  c.block(message + failDetail);
});
