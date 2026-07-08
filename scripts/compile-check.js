#!/usr/bin/env node
'use strict';
// PostToolUse (Edit|Write|MultiEdit): compile/syntax-check the just-edited
// file, feeding any error straight back to Claude.
//
// Checks are configurable per project as numbered steps in
// .claude/validation/hooks.env (see hooks.env.example): each step is a
// file-match regex plus a shell command with {file}/{root}/{devenv}
// placeholders, with optional PRECHECK (non-zero exit -> skip quietly),
// ERROR_RE (fail on output match even at exit 0), CWD and TIMEOUT_MS.
// With no steps configured this falls back to the original Chimera
// behaviour: `perl -c` inside the docker-compose `api` container for
// *.pm/*.pl, skipping quietly (failing open) when that container isn't
// running.

const { execFileSync } = require('node:child_process');
const c = require('./lib/common.js');

function shQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }

function fill(tpl, rel) {
  return tpl
    .replace(/\{file\}/g, shQuote(rel))
    .replace(/\{root\}/g, c.repoRoot())
    .replace(/\{devenv\}/g, c.devenvDir());
}

// rc is null when the command could not run at all (spawn failure, timeout
// kill) — callers must skip rather than block, keeping the hook fail-open.
function sh(cmd, cwd, timeout) {
  try {
    const out = execFileSync('/bin/sh', ['-c', cmd], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { rc: 0, out };
  } catch (e) {
    return {
      rc: typeof e.status === 'number' ? e.status : null,
      out: `${e.stdout || ''}${e.stderr || ''}`,
    };
  }
}

// Numbered steps: UK2_COMPILE_CHECK_<n>_CMD plus optional _MATCH, _CWD,
// _PRECHECK, _ERROR_RE, _TIMEOUT_MS. Gaps in the numbering are fine.
function loadSteps(src) {
  const steps = [];
  for (let n = 1; n <= 20; n += 1) {
    const cmd = c.envc(`COMPILE_CHECK_${n}_CMD`, src);
    if (!cmd) continue;
    steps.push({
      n,
      cmd,
      match: c.envc(`COMPILE_CHECK_${n}_MATCH`, src),
      cwd: c.envc(`COMPILE_CHECK_${n}_CWD`, src),
      precheck: c.envc(`COMPILE_CHECK_${n}_PRECHECK`, src),
      errorRe: c.envc(`COMPILE_CHECK_${n}_ERROR_RE`, src),
      timeoutMs: Number(c.envc(`COMPILE_CHECK_${n}_TIMEOUT_MS`, src)) || 60000,
    });
  }
  return steps;
}

function runConfigured(input, rel, steps) {
  for (const s of steps) {
    if (s.match) {
      let re;
      try { re = new RegExp(s.match); } catch {
        process.stderr.write(`uk2-claude-hooks: compile-check step ${s.n}: invalid MATCH regex — step skipped\n`);
        continue;
      }
      if (!re.test(rel)) continue;
    }
    const cwd = s.cwd ? fill(s.cwd, rel) : c.repoRoot();
    if (s.precheck && sh(fill(s.precheck, rel), cwd, 15000).rc !== 0) {
      process.stderr.write(`uk2-claude-hooks: compile-check step ${s.n}: precheck failed — skipping for ${rel}\n`);
      continue;
    }
    const r = sh(fill(s.cmd, rel), cwd, s.timeoutMs);
    if (r.rc === null) {
      process.stderr.write(`uk2-claude-hooks: compile-check step ${s.n}: command could not run — skipping for ${rel}\n`);
      continue;
    }
    let failed = r.rc !== 0;
    if (!failed && s.errorRe) {
      try { failed = new RegExp(s.errorRe, 'm').test(r.out); } catch { /* invalid regex: exit code already decided */ }
    }
    if (!failed) continue;
    const first = r.out.split('\n').slice(0, 20).join('\n');
    c.logEvent(input, 'compile_fail', { file: rel, step: s.n, cmd: s.cmd, error: c.trunc(first, 1500) });
    c.block(`compile-check step ${s.n} (${s.cmd}) failed for ${rel} (exit ${r.rc}):\n\n${first}\n\n`
      + 'Fix this before continuing — the file does not pass the project compile check.');
  }
}

// Original Chimera behaviour, kept as the zero-config default.
function runLegacy(input, rel) {
  if (!rel.endsWith('.pm') && !rel.endsWith('.pl')) return;

  const dev = c.devenvDir();

  // Only meaningful when the api container is up; skip quietly otherwise so
  // local editing without a running container is never blocked.
  let ps = '';
  try {
    ps = execFileSync('docker', ['compose', 'ps', 'api'], {
      cwd: dev, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    });
  } catch { /* no docker / no compose project here */ }
  if (!/up|running/i.test(ps)) {
    process.stderr.write(`uk2-claude-hooks: api container not running — skipping compile-check for ${rel}\n`);
    return;
  }

  // Build the -I list: always lib; add a Dancer service lib when the file is under one.
  const incs = ['-Ilib'];
  const dancer = rel.match(/^dancer\/([^/]+)\/lib\//);
  if (dancer) incs.push(`-Idancer/${dancer[1]}/lib`);

  let out = '';
  let rc = 0;
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'api', 'perl', ...incs, '-c', rel], {
      cwd: dev, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    });
  } catch (e) {
    rc = typeof e.status === 'number' ? e.status : 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }

  if (rc !== 0) {
    const first = out.split('\n').slice(0, 20).join('\n');
    c.logEvent(input, 'compile_fail', { file: rel, error: c.trunc(first, 1500) });
    c.block(`perl -c failed for ${rel} (exit ${rc}):\n\n${first}\n\n`
      + 'Fix this compile error before continuing — the file does not parse.');
  }
}

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const filePath = c.get(input, 'tool_input.file_path');
  if (!filePath) return;
  const rel = c.relPath(String(filePath));

  const src = c.hooksConfig();
  if (c.envc('COMPILE_CHECK_DISABLE', src)) return;

  const steps = loadSteps(src);
  if (steps.length) runConfigured(input, rel, steps);
  else runLegacy(input, rel);
});
