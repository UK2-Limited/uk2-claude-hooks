#!/usr/bin/env node
'use strict';
// PostToolUse (Edit|Write|MultiEdit) on *.pm/*.pl: fast `perl -c` compile
// check in the dev container, feeding any error straight back to Claude.
// Chimera-specific by nature — skips quietly (fails open) in any repo where
// the docker-compose `api` service isn't running.

const { execFileSync } = require('node:child_process');
const c = require('./lib/common.js');

c.run((input) => {
  const tool = c.get(input, 'tool_name');
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const filePath = c.get(input, 'tool_input.file_path');
  if (!filePath) return;
  const rel = c.relPath(String(filePath));
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
});
