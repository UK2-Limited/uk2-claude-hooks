#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): re-run the self-test suite after an edit to
// hook sources (scripts/, hooks/, test/). Fails open on anything except a genuine
// test failure, which is fed back to Claude via exit code 2 + stderr.
const { spawnSync } = require('node:child_process');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let file = '';
  try {
    file = JSON.parse(data).tool_input?.file_path || '';
  } catch {
    process.exit(0);
  }
  if (!/\/(scripts|hooks|test)\//.test(file)) process.exit(0);
  if (/\/\.claude\//.test(file)) process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = spawnSync('node', ['test/run.js'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) process.exit(0);

  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
  console.error(`node test/run.js failed after editing ${file}:\n` + out.slice(-30).join('\n'));
  process.exit(2);
});
