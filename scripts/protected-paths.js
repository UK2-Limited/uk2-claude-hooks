#!/usr/bin/env node
'use strict';
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit): block writes to protected
// paths. Rules live in <project>/.claude/validation/protected-paths.txt
// (single source of truth per consuming repo).
//   deny -> permissionDecision:"deny" (holds under bypassPermissions)
//   warn -> allow + telemetry flag + stderr advisory

// DISABLED for now (parity with the Chimera branch that this plugin was
// extracted from) — re-enable together with the skipped deny tests in
// test/run.js.
process.exit(0);

/* eslint-disable no-unreachable */
const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  const filePath = c.get(input, 'tool_input.file_path') || c.get(input, 'tool_input.notebook_path');
  if (!filePath) return;
  const rel = c.relPath(String(filePath));

  const policyFile = path.join(c.repoRoot(), '.claude', 'validation', 'protected-paths.txt');
  let policy = '';
  try { policy = fs.readFileSync(policyFile, 'utf8'); } catch { return; }

  // Deny rules are listed before warn rules; deny exits immediately.
  for (const raw of policy.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep < 1) continue;
    const mode = line.slice(0, sep);
    const pat = line.slice(sep + 1);
    if (!pat) continue;

    if (c.pathMatches(rel, pat)) {
      if (mode === 'deny') {
        c.logEvent(input, 'protected_deny', { path: rel, rule: pat, tool });
        c.deny(`Refused: '${rel}' is a protected path (rule: ${pat}). The agent may not modify `
          + 'gate/config/secret files. A human must edit it directly, or change the policy in a '
          + 'reviewed PR.');
      } else if (mode === 'warn') {
        c.logEvent(input, 'protected_warn', { path: rel, rule: pat, tool });
        process.stderr.write(`uk2-claude-hooks: WARNING — editing high-blast-radius path '${rel}' `
          + `(rule: ${pat}). Such changes are human-reviewed; confirm the issue is approved for this.\n`);
      }
    }
  }
});
