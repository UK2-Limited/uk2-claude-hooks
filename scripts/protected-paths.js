#!/usr/bin/env node
'use strict';
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit): block writes to protected
// paths. Rules are the protectedPaths block in .claude/validation/hooks.json
// (see hooks.json.example):
//   deny -> permissionDecision:"deny" (holds under bypassPermissions)
//   warn -> allow + telemetry flag + stderr advisory
// With no protectedPaths config the hook does nothing — parity with the
// Chimera branch, where this gate shipped disabled. The Chimera-era
// .claude/validation/protected-paths.txt file is intentionally no longer
// read; a stderr nag points at the migration.

const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  const filePath = c.get(input, 'tool_input.file_path') || c.get(input, 'tool_input.notebook_path');
  if (!filePath) return;
  const rel = c.relPath(String(filePath));

  const cfg = c.hooksConfig();
  if (cfg === null) return; // broken hooks.json — fail open, never block
  const pp = cfg.protectedPaths;
  if (!pp || typeof pp !== 'object' || Array.isArray(pp)) {
    const legacy = path.join(c.repoRoot(), '.claude', 'validation', 'protected-paths.txt');
    if (fs.existsSync(legacy)) {
      process.stderr.write(`uk2-claude-hooks: ${legacy} is no longer read — move its rules to `
        + 'protectedPaths in hooks.json (see README)\n');
    }
    return;
  }
  if (pp.disable || c.envc('PROTECTED_PATHS_DISABLE')) return;

  // Deny beats warn; the first matching deny rule exits immediately.
  for (const pat of Array.isArray(pp.deny) ? pp.deny : []) {
    if (typeof pat === 'string' && pat && c.pathMatches(rel, pat)) {
      c.logEvent(input, 'protected_deny', { path: rel, rule: pat, tool });
      c.deny(`Refused: '${rel}' is a protected path (rule: ${pat}). The agent may not modify `
        + 'gate/config/secret files. A human must edit it directly, or change the policy in a '
        + 'reviewed PR.');
    }
  }
  for (const pat of Array.isArray(pp.warn) ? pp.warn : []) {
    if (typeof pat === 'string' && pat && c.pathMatches(rel, pat)) {
      c.logEvent(input, 'protected_warn', { path: rel, rule: pat, tool });
      process.stderr.write(`uk2-claude-hooks: WARNING — editing high-blast-radius path '${rel}' `
        + `(rule: ${pat}). Such changes are human-reviewed; confirm the issue is approved for this.\n`);
    }
  }
});
