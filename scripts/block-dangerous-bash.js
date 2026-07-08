#!/usr/bin/env node
'use strict';
// PreToolUse (Bash): hard floor under the permission allowlist. Always on,
// every environment. Blocks catastrophic commands; conservative patterns to
// avoid false positives. Each statement in a compound command is checked
// independently, so flags/targets from different commands on one line cannot
// combine into a false positive.

const c = require('./lib/common.js');

c.run((input) => {
  if (c.get(input, 'tool_name') !== 'Bash') return;
  const cmd = String(c.get(input, 'tool_input.command') || '');
  if (!cmd) return;

  // Local human override (never honoured in CI / agent mode).
  if (c.envc('ALLOW_DANGEROUS') === '1' && !c.isAgentMode()) return;

  const RM_TARGET = /\s(\/|\/\*|~|~\/|\$HOME|\.|\.\.|\*)(\s|$)/;
  let reason = '';

  // Split the command into statements on ; && || | and newlines.
  for (const stmt of cmd.split(/\|\||&&|[;|\n]/)) {
    if (!stmt.trim()) continue;

    // 1) recursive/forced rm of root / home / cwd / bare glob
    if (!reason
        && /(^|\s)rm(\s|$)/i.test(stmt)
        && (/(^|\s)-[a-z0-9]*r/i.test(stmt) || /--recursive/i.test(stmt))
        && (/(^|\s)-[a-z0-9]*f/i.test(stmt) || /--force/i.test(stmt))
        && RM_TARGET.test(stmt)) {
      reason = "recursive/forced 'rm' targeting a root / home / cwd / glob path";
    }

    // 2) force-push (rewrites remote history)
    if (!reason && /git\s+push/i.test(stmt)
        && /(--force([^-]|$)|--force-with-lease|(^|\s)-f(\s|$))/i.test(stmt)) {
      reason = "'git push --force' rewrites remote history";
    }

    // 3) destructive SQL against a non-test database
    if (!reason
        && /(DROP\s+DATABASE|DROP\s+TABLE|TRUNCATE\s+TABLE)/i.test(stmt)
        && !/test/i.test(stmt)) {
      reason = 'DROP/TRUNCATE against a non-test database';
    }

    // 4) docker compose volume wipe (deletes DB / storage volumes)
    if (!reason && /docker(-|\s+)compose\s+down/i.test(stmt)
        && /(-v(\s|$)|--volumes)/i.test(stmt)) {
      reason = "'docker compose down -v' deletes named volumes (DB / object-storage data)";
    }

    if (reason) break;
  }

  if (reason) {
    c.logEvent(input, 'dangerous_bash_blocked', { command: c.trunc(cmd, 300), reason });
    c.deny(`Refused: ${reason}. This is a destructive command the agent must not run. `
      + '(A human can set UK2_ALLOW_DANGEROUS=1 locally to override — never in CI.)');
  }
});
