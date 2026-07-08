#!/usr/bin/env node
'use strict';
// PreToolUse (Edit|Write|MultiEdit) on test/fixture files: flag/deny weakening
// of pre-existing test assertions. Hard-deny in agent/CI mode; warn-only
// locally.

const c = require('./lib/common.js');

const ASSERT_RE = /(^|[^A-Za-z0-9_])(ok|is|isnt|like|unlike|cmp_ok|is_deeply|isa_ok|can_ok|throws_ok|lives_ok|dies_ok|warning_is|done_testing)\s*\(/g;
const SKIP_RE = /(\bskip_all\b|->\s*skip\b|#\s*TODO|\bplan\b[^;]*skip|^\s*#.*\b(ok|is|cmp_ok|is_deeply|isa_ok|like)\s*\()/im;

function countAsserts(text) { return (text.match(ASSERT_RE) || []).length; }

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const filePath = c.get(input, 'tool_input.file_path');
  if (!filePath) return;
  const rel = c.relPath(String(filePath));

  // Only act on test / fixture files.
  const isTest = rel.endsWith('.t')
    || rel.startsWith('t/') || rel.includes('/t/')
    || (rel.includes('Test') && rel.endsWith('.pm'))
    || /[Ff]ixtures/.test(rel);
  if (!isTest) return;

  // Gather the "before" and "after" text for an assertion-density comparison.
  let oldText = '';
  let newText = '';
  if (tool === 'Edit') {
    oldText = String(c.get(input, 'tool_input.old_string') || '');
    newText = String(c.get(input, 'tool_input.new_string') || '');
  } else if (tool === 'MultiEdit') {
    const edits = c.get(input, 'tool_input.edits');
    if (Array.isArray(edits)) {
      oldText = edits.map((e) => e.old_string || '').join('\n');
      newText = edits.map((e) => e.new_string || '').join('\n');
    }
  } else {
    newText = String(c.get(input, 'tool_input.content') || '');
    oldText = c.gitOut(['show', `HEAD:${rel}`]);
  }

  const oldN = countAsserts(oldText);
  const newN = countAsserts(newText);

  let weak = '';
  if (oldN > newN) weak = `assertion count dropped (${oldN} -> ${newN})`;
  if (SKIP_RE.test(newText) && !SKIP_RE.test(oldText)) {
    weak = `${weak ? `${weak}; ` : ''}introduced SKIP/TODO/commented-out assertion`;
  }
  if (!weak) return;

  const mode = c.isAgentMode() ? 'agent' : 'interactive';
  c.logEvent(input, 'test_integrity', {
    path: rel, detail: weak, assertions_before: oldN, assertions_after: newN, mode,
  });

  if (c.isAgentMode()) {
    c.deny(`Test-integrity guard: '${rel}' — ${weak}. Acceptance criteria are held-out: satisfy `
      + 'the tests, never weaken pre-existing assertions. If a criterion cannot pass honestly, '
      + 'take the abort path and flag needs-human (implement-plan §5).');
  } else {
    process.stderr.write(`uk2-claude-hooks: WARNING test-integrity — '${rel}': ${weak} `
      + '(warn-only locally; would hard-block in agent/CI mode).\n');
  }
});
