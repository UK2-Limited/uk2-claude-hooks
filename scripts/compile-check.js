#!/usr/bin/env node
'use strict';
// PostToolUse (Edit|Write|MultiEdit): compile/syntax-check the just-edited
// file, feeding any error straight back to Claude.
//
// Checks are configurable per project as the compileCheck.steps array in
// .claude/validation/hooks.json (see hooks.json.example): each step is a
// file-match regex plus a shell command with {file}/{root}/{devenv}
// placeholders, with optional precheck (non-zero exit -> skip quietly),
// errorRe (fail on output match even at exit 0), cwd and timeoutMs.
// With no steps key configured this falls back to the original Chimera
// behaviour: `perl -c` inside the docker-compose `api` container for
// *.pm/*.pl, skipping quietly (failing open) when that container isn't
// running. An explicit empty steps array means "no checks".

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

// compileCheck.steps entries: cmd (required) plus optional match, cwd,
// precheck, errorRe, timeoutMs. Step numbers are 1-based array positions.
function normalizeSteps(raw) {
  const steps = [];
  raw.forEach((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== 'object' || typeof s.cmd !== 'string' || !s.cmd) {
      process.stderr.write(`uk2-claude-hooks: compile-check step ${n}: missing cmd — step skipped\n`);
      return;
    }
    steps.push({
      n,
      cmd: s.cmd,
      match: typeof s.match === 'string' ? s.match : '',
      cwd: typeof s.cwd === 'string' ? s.cwd : '',
      precheck: typeof s.precheck === 'string' ? s.precheck : '',
      errorRe: typeof s.errorRe === 'string' ? s.errorRe : '',
      timeoutMs: Number(s.timeoutMs) || 60000,
    });
  });
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

  const cfg = c.hooksConfig();
  if (cfg === null) return; // broken hooks.json — fail open, never block
  const cc = cfg.compileCheck || {};
  if (cc.disable || c.envc('COMPILE_CHECK_DISABLE')) return;

  if (Array.isArray(cc.steps)) runConfigured(input, rel, normalizeSteps(cc.steps));
  else runLegacy(input, rel);
});
