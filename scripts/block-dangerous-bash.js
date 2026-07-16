#!/usr/bin/env node
'use strict';
// PreToolUse (Bash): hard floor under the permission allowlist. Always on,
// every environment. Blocks catastrophic commands; conservative patterns to
// avoid false positives. Each statement in a compound command is checked
// independently, so flags/targets from different commands on one line cannot
// combine into a false positive.
//
// Rules are configurable as dangerousBash.rules in
// .claude/validation/hooks.json (hooks.json.example spells out the built-in
// defaults). Each rule: reason (required) + match (case-insensitive regexes
// that must ALL hit one statement) + optional noMatch (none may hit). A
// configured rules array REPLACES the built-ins. Unlike the other gates, a
// broken hooks.json falls back to the built-in rules — a parse error must
// never drop the floor.

const c = require('./lib/common.js');

const DEFAULT_RULES = [
  { // recursive/forced rm of root / home / cwd / bare glob
    reason: "recursive/forced 'rm' targeting a root / home / cwd / glob path",
    match: [
      '(^|\\s)rm(\\s|$)',
      '(^|\\s)-[a-z0-9]*r|--recursive',
      '(^|\\s)-[a-z0-9]*f|--force',
      '\\s(/|/\\*|~|~/|\\$HOME|\\.|\\.\\.|\\*)(\\s|$)',
    ],
  },
  { // force-push (rewrites remote history)
    reason: "'git push --force' rewrites remote history",
    match: ['git\\s+push', '--force([^-]|$)|--force-with-lease|(^|\\s)-f(\\s|$)'],
  },
  { // destructive SQL against a non-test database
    reason: 'DROP/TRUNCATE against a non-test database',
    match: ['DROP\\s+DATABASE|DROP\\s+TABLE|TRUNCATE\\s+TABLE'],
    noMatch: ['test'],
  },
  { // docker compose volume wipe (deletes DB / storage volumes)
    reason: "'docker compose down -v' deletes named volumes (DB / object-storage data)",
    match: ['docker(-|\\s+)compose\\s+down', '-v(\\s|$)|--volumes'],
  },
];

// A rule that doesn't compile is skipped with a stderr note; the remaining
// rules still apply (fail open per rule, never for the whole floor).
function compileRules(raw) {
  const rules = [];
  raw.forEach((r, i) => {
    const n = i + 1;
    try {
      if (!r || typeof r !== 'object' || typeof r.reason !== 'string' || !r.reason
          || !Array.isArray(r.match) || !r.match.length) throw new Error('bad rule');
      rules.push({
        reason: r.reason,
        match: r.match.map((p) => new RegExp(p, 'i')),
        noMatch: (Array.isArray(r.noMatch) ? r.noMatch : []).map((p) => new RegExp(p, 'i')),
      });
    } catch {
      process.stderr.write(`uk2-claude-hooks: dangerous-bash rule ${n}: invalid — rule skipped\n`);
    }
  });
  return rules;
}

c.run((input) => {
  if (c.get(input, 'tool_name') !== 'Bash') return;
  const cmd = String(c.get(input, 'tool_input.command') || '');
  if (!cmd) return;

  // Local human override (never honoured in CI / agent mode).
  if (c.envc('ALLOW_DANGEROUS') === '1' && !c.isAgentMode()) return;

  // Broken hooks.json -> {} here, NOT skip: the floor survives our own parse failure.
  const db = (c.hooksConfig() || {}).dangerousBash || {};
  if (db.disable) return;
  const rules = compileRules(Array.isArray(db.rules) ? db.rules : DEFAULT_RULES);

  let reason = '';
  // Split the command into statements on ; && || | and newlines.
  for (const stmt of cmd.split(/\|\||&&|[;|\n]/)) {
    if (!stmt.trim()) continue;
    for (const r of rules) {
      if (r.match.every((re) => re.test(stmt)) && !r.noMatch.some((re) => re.test(stmt))) {
        reason = r.reason;
        break;
      }
    }
    if (reason) break;
  }

  if (reason) {
    c.logEvent(input, 'dangerous_bash_blocked', { command: c.trunc(c.relCmd(cmd, input), 300), reason });
    c.deny(`Refused: ${reason}. This is a destructive command the agent must not run. `
      + '(A human can set UK2_ALLOW_DANGEROUS=1 locally to override — never in CI.)');
  }
});
