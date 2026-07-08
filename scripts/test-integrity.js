#!/usr/bin/env node
'use strict';
// PreToolUse (Edit|Write|MultiEdit) on test/fixture files: flag/deny weakening
// of pre-existing test assertions. Hard-deny in agent/CI mode; warn-only
// locally.
//
// The Perl-flavoured defaults below are overridable per project via the
// testIntegrity block in .claude/validation/hooks.json (see
// hooks.json.example):
//   fileRe    which repo-relative paths count as tests
//   assertRe  assertion pattern, counted before/after (flag g)
//   skipRe    skip/TODO/commented-assertion pattern (flags im)
//   disable   turn the hook off (UK2_TEST_INTEGRITY_DISABLE env var also works)

const c = require('./lib/common.js');

const DEFAULT_ASSERT_RE = /(^|[^A-Za-z0-9_])(ok|is|isnt|like|unlike|cmp_ok|is_deeply|isa_ok|can_ok|throws_ok|lives_ok|dies_ok|warning_is|done_testing)\s*\(/g;
const DEFAULT_SKIP_RE = /(\bskip_all\b|->\s*skip\b|#\s*TODO|\bplan\b[^;]*skip|^\s*#.*\b(ok|is|cmp_ok|is_deeply|isa_ok|like)\s*\()/im;

function isTestDefault(rel) {
  return rel.endsWith('.t')
    || rel.startsWith('t/') || rel.includes('/t/')
    || (rel.includes('Test') && rel.endsWith('.pm'))
    || /[Ff]ixtures/.test(rel);
}

// undefined = key not configured (use the default); null = configured but the
// pattern doesn't compile — the caller must fail open, not fall back silently
// to defaults meant for a different language.
function cfgRe(pat, name, flags) {
  if (typeof pat !== 'string' || !pat) return undefined;
  try { return new RegExp(pat, flags); } catch {
    process.stderr.write(`uk2-claude-hooks: test-integrity: invalid ${name} regex — check skipped\n`);
    return null;
  }
}

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const filePath = c.get(input, 'tool_input.file_path');
  if (!filePath) return;
  const rel = c.relPath(String(filePath));

  const cfg = c.hooksConfig();
  if (cfg === null) return; // broken hooks.json — fail open, never deny
  const ti = cfg.testIntegrity || {};
  if (ti.disable || c.envc('TEST_INTEGRITY_DISABLE')) return;

  // Only act on test / fixture files.
  const fileRe = cfgRe(ti.fileRe, 'fileRe', '');
  if (fileRe === null) return;
  if (fileRe ? !fileRe.test(rel) : !isTestDefault(rel)) return;

  const assertRe = cfgRe(ti.assertRe, 'assertRe', 'g');
  const skipRe = cfgRe(ti.skipRe, 'skipRe', 'im');
  if (assertRe === null || skipRe === null) return;
  const aRe = assertRe || DEFAULT_ASSERT_RE;
  const sRe = skipRe || DEFAULT_SKIP_RE;
  const countAsserts = (text) => (text.match(aRe) || []).length;

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
  if (sRe.test(newText) && !sRe.test(oldText)) {
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
