#!/usr/bin/env node
'use strict';
// Self-test for the uk2-claude-hooks plugin. Spawns each hook with sample
// stdin payloads against a THROWAWAY project directory and asserts the
// deny / allow / block / context contract plus the telemetry event shapes.
// Run locally or in CI:
//     node test/run.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const FIXTURES = path.join(__dirname, 'fixtures');
const TRANSCRIPT = path.join(FIXTURES, 'transcript.jsonl');
const SID = 'hooktest';

// --- scratch project: every hook runs against this, never against a real repo ---
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'uk2-hooks-test-'));
process.on('exit', () => { try { fs.rmSync(PROJ, { recursive: true, force: true }); } catch { /* best effort */ } });

function gitP(...args) { execFileSync('git', ['-C', PROJ, ...args], { stdio: ['ignore', 'ignore', 'ignore'] }); }
gitP('init', '-q', '-b', 'main');
gitP('config', 'user.email', 'hooktest@uk2group.com');
gitP('config', 'user.name', 'Hook Test');
gitP('config', 'commit.gpgsign', 'false');
gitP('commit', '-q', '--allow-empty', '-m', 'init');
const HEAD = execFileSync('git', ['-C', PROJ, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

fs.mkdirSync(path.join(PROJ, '.claude', 'validation'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude', 'state'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.claude', 'validation', 'protected-paths.txt'),
  'deny:conf/production/\ndeny:**/.env\ndeny:**/secrets/**\nwarn:database/structure/\n');
fs.writeFileSync(path.join(PROJ, '.claude', 'agents', 'fixture-inherit.md'),
  '---\nname: fixture-inherit\nmodel: inherit\n---\nbody\n');
fs.writeFileSync(path.join(PROJ, '.claude', 'agents', 'fixture-pinned.md'),
  '---\nname: fixture-pinned\nmodel: sonnet\n---\nbody\n');

const SESS = path.join(PROJ, '.claude', 'telemetry', 'sessions', `${SID}.jsonl`);
const SPOOL = path.join(PROJ, '.claude', 'telemetry', 'unshipped.jsonl');
const TICKET = path.join(PROJ, '.claude', 'state', 'ticket.json');
const VERIFY = path.join(PROJ, '.claude', 'state', 'verify.json');
const CAP = path.join(PROJ, '.claude', 'state', `stop-blocks-${SID}`);
// Scratch hooks.env for the configured-gate tests (passed via UK2_HOOKS_CONFIG).
const HOOKSENV = path.join(PROJ, 'hooks-test.env');

// --- harness ---
let pass = 0;
let fail = 0;
let skipped = 0;
let OUT = '';
let ERR = '';
let RC = 0;

function run(script, payload, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: PROJ, UK2_TELEMETRY_CONFIG: '/nonexistent-telemetry.env' };
  // Never inherit ambient agent-mode / telemetry state from the caller's shell.
  for (const k of ['CI', 'UK2_AGENT_MODE', 'CHIMERA_AGENT_MODE', 'UK2_ALLOW_DANGEROUS',
    'CHIMERA_ALLOW_DANGEROUS', 'UK2_ISSUE', 'CHIMERA_ISSUE', 'UK2_TELEMETRY_DISABLE',
    'CHIMERA_TELEMETRY_DISABLE', 'CHIMERA_TELEMETRY_CONFIG', 'UK2_TELEMETRY_SPOOL',
    'CHIMERA_TELEMETRY_SPOOL', 'UK2_DEVENV_DIR', 'CHIMERA_DEVENV_DIR']) delete env[k];
  // Ditto for any ambient gate config (hooks.env keys as env vars).
  for (const k of Object.keys(env)) {
    if (/^(UK2|CHIMERA)_(HOOKS_CONFIG|COMPILE_CHECK|TEST_INTEGRITY|STOP_GATE)/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000, env,
  });
  OUT = r.stdout || '';
  ERR = r.stderr || '';
  RC = r.status === null ? -1 : r.status;
}

function ok(name) { pass += 1; console.log(`  ok   ${name}`); }
function no(name) { fail += 1; console.log(`  FAIL ${name}\n       out=[${OUT.trim()}] rc=${RC} err=[${ERR.trim()}]`); }
function skip(name) { skipped += 1; console.log(`  skip ${name}`); }
function check(name, cond) { if (cond) ok(name); else no(name); }
function wantDeny(name) { check(name, OUT.includes('"permissionDecision":"deny"')); }
function wantBlock(name) { check(name, OUT.includes('"decision":"block"')); }
function wantAllow(name) {
  check(name, RC === 0 && !OUT.includes('"permissionDecision":"deny"') && !OUT.includes('"decision":"block"'));
}
function wantCtx(name) { check(name, OUT.includes('additionalContext')); }

function events(type, file = SESS) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((e) => e.event === type);
  } catch { return []; }
}
function lastEvent(type) { const all = events(type); return all[all.length - 1] || null; }
function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

// Poll until the spool is non-empty AND stable across two consecutive reads
// (the detached shipper may be mid-flush, which briefly renames the file away).
async function waitSpoolStable(timeoutMs = 10000) {
  let prev = '';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let cur = '';
    try { cur = fs.readFileSync(SPOOL, 'utf8'); } catch { /* not yet */ }
    if (cur && cur === prev) return cur;
    prev = cur;
    await sleep(150);
  }
  return prev;
}

(async () => {
  console.log('== protected-paths (hook disabled — re-enable these together with protected-paths.js) ==');
  skip('deny conf/production');
  skip('deny **/.env');
  skip('deny **/secrets/**');
  run('protected-paths.js', { session_id: SID, tool_name: 'Write', tool_input: { file_path: 'conf/production/all/x.yml' } });
  wantAllow('disabled hook allows everything');

  console.log('== block-dangerous-bash ==');
  const bash = (command) => ({ session_id: SID, tool_name: 'Bash', tool_input: { command } });
  run('block-dangerous-bash.js', bash('rm -rf /')); wantDeny('deny rm -rf root');
  run('block-dangerous-bash.js', bash('rm -rf ~')); wantDeny('deny rm -rf home');
  run('block-dangerous-bash.js', bash('git push --force origin master')); wantDeny('deny git push --force');
  run('block-dangerous-bash.js', bash('cd ../ && docker compose down -v')); wantDeny('deny docker compose down volumes');
  run('block-dangerous-bash.js', bash('mysql -e "DROP DATABASE chimera"')); wantDeny('deny DROP DATABASE non-test');
  run('block-dangerous-bash.js', bash('rm -rf ./tmp/build')); wantAllow('allow scoped recursive delete');
  run('block-dangerous-bash.js', bash('mysql -e "TRUNCATE TABLE test_widgets"')); wantAllow('allow TRUNCATE test table');
  run('block-dangerous-bash.js', bash('prove -r t/')); wantAllow('allow prove');
  run('block-dangerous-bash.js', bash('rm -rf /'), { UK2_ALLOW_DANGEROUS: '1' }); wantAllow('human override allows locally');
  run('block-dangerous-bash.js', bash('rm -rf /'), { UK2_ALLOW_DANGEROUS: '1', UK2_AGENT_MODE: 'implement' });
  wantDeny('override ignored in agent mode');

  console.log('== test-integrity ==');
  const editDrop = {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 't/foo.t', old_string: 'ok(1);\nis($a,$b);', new_string: 'ok(1);' },
  };
  run('test-integrity.js', editDrop, { UK2_AGENT_MODE: 'implement' }); wantDeny('agent-mode deny assertion drop');
  run('test-integrity.js', editDrop, { CHIMERA_AGENT_MODE: 'implement' }); wantDeny('legacy CHIMERA_AGENT_MODE also denies');
  run('test-integrity.js', editDrop); wantAllow('interactive warn(allow) assertion drop');
  run('test-integrity.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 'lib/Foo.pm', old_string: 'ok(1);\nis(1,1);', new_string: 'ok(1);' },
  }, { UK2_AGENT_MODE: 'implement' }); wantAllow('ignore non-test file');
  run('test-integrity.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 't/foo.t', old_string: 'ok(1);', new_string: 'ok(1);\nis($a,$b);' },
  }, { UK2_AGENT_MODE: 'implement' }); wantAllow('allow added assertion');

  console.log('== test-integrity (configured regexes) ==');
  const jsDrop = {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/foo.test.js',
      old_string: 'expect(a).toBe(1);\nexpect(b).toBe(2);',
      new_string: 'expect(a).toBe(1);',
    },
  };
  run('test-integrity.js', jsDrop, { UK2_AGENT_MODE: 'implement' });
  wantAllow('js test file ignored by default heuristics');
  fs.writeFileSync(HOOKSENV,
    'UK2_TEST_INTEGRITY_FILE_RE="\\.test\\.js$"\n'
    + 'UK2_TEST_INTEGRITY_ASSERT_RE="\\bexpect\\s*\\("\n'
    + 'UK2_TEST_INTEGRITY_SKIP_RE="\\b(it|test)\\.skip\\b"\n');
  run('test-integrity.js', jsDrop, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantDeny('configured ASSERT_RE denies js assertion drop');
  run('test-integrity.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 'src/foo.test.js', old_string: "it('x', f);", new_string: "it.skip('x', f);" },
  }, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantDeny('configured SKIP_RE denies introduced skip');
  run('test-integrity.js', editDrop, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantAllow('FILE_RE override replaces the perl heuristic');
  run('test-integrity.js', editDrop, { UK2_AGENT_MODE: 'implement', UK2_TEST_INTEGRITY_DISABLE: '1' });
  wantAllow('UK2_TEST_INTEGRITY_DISABLE turns hook off');
  fs.rmSync(HOOKSENV, { force: true });

  console.log('== compile-check (skip paths) ==');
  run('compile-check.js', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'lib/Foo.pm' } },
    { UK2_DEVENV_DIR: '/nonexistent-devenv' });
  wantAllow('skip when api down');
  run('compile-check.js', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'README.md' } });
  wantAllow('ignore non-perl file');

  console.log('== compile-check (configured steps) ==');
  const ccEdit = (fp) => ({ session_id: SID, tool_name: 'Edit', tool_input: { file_path: fp } });
  const ccRun = (payload, extra = {}) => run('compile-check.js', payload, { UK2_HOOKS_CONFIG: HOOKSENV, ...extra });

  fs.writeFileSync(HOOKSENV,
    'UK2_COMPILE_CHECK_1_MATCH="\\.pm$"\n'
    + 'UK2_COMPILE_CHECK_1_CMD="echo compile error in {file} >&2; exit 2"\n');
  ccRun(ccEdit('lib/Foo.pm'));
  wantBlock('failing step blocks');
  check('block carries command output', OUT.includes('compile error in'));
  const cf = lastEvent('compile_fail');
  check('compile_fail logged with step+cmd', cf && cf.step === 1 && cf.file === 'lib/Foo.pm' && typeof cf.cmd === 'string');

  fs.writeFileSync(HOOKSENV, 'UK2_COMPILE_CHECK_1_MATCH="\\.pm$"\nUK2_COMPILE_CHECK_1_CMD="true"\n');
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('passing step allows');

  fs.writeFileSync(HOOKSENV, 'UK2_COMPILE_CHECK_1_MATCH="\\.ts$"\nUK2_COMPILE_CHECK_1_CMD="exit 1"\n');
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('non-matching step skipped');

  fs.writeFileSync(HOOKSENV, 'UK2_COMPILE_CHECK_1_PRECHECK="false"\nUK2_COMPILE_CHECK_1_CMD="exit 1"\n');
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('failed precheck skips quietly');

  fs.writeFileSync(HOOKSENV,
    'UK2_COMPILE_CHECK_1_CMD="echo WARNING: unresolved reference"\n'
    + 'UK2_COMPILE_CHECK_1_ERROR_RE="unresolved reference"\n');
  ccRun(ccEdit('lib/Foo.pm')); wantBlock('ERROR_RE match blocks despite exit 0');

  fs.writeFileSync(HOOKSENV, 'UK2_COMPILE_CHECK_1_CMD="true"\nUK2_COMPILE_CHECK_2_CMD="exit 3"\n');
  ccRun(ccEdit('lib/Foo.pm')); wantBlock('second step failure blocks');

  fs.writeFileSync(HOOKSENV, 'UK2_COMPILE_CHECK_1_MATCH="\\.md$"\nUK2_COMPILE_CHECK_1_CMD="exit 1"\n');
  ccRun(ccEdit('docs/README.md')); wantBlock('configured steps reach beyond .pm/.pl');

  fs.writeFileSync(HOOKSENV, 'UK2_COMPILE_CHECK_1_CMD="exit 1"\n');
  ccRun(ccEdit('lib/Foo.pm'), { UK2_COMPILE_CHECK_DISABLE: '1' });
  wantAllow('UK2_COMPILE_CHECK_DISABLE turns hook off');
  fs.rmSync(HOOKSENV, { force: true });

  const DEFHOOKSENV = path.join(PROJ, '.claude', 'validation', 'hooks.env');
  fs.writeFileSync(DEFHOOKSENV, 'UK2_COMPILE_CHECK_1_CMD="exit 1"\n');
  run('compile-check.js', ccEdit('lib/Foo.pm'));
  wantBlock('default .claude/validation/hooks.env is picked up');
  fs.rmSync(DEFHOOKSENV, { force: true });

  console.log('== stop-require-evidence ==');
  fs.rmSync(VERIFY, { force: true }); fs.rmSync(CAP, { force: true });
  run('stop-require-evidence.js', { session_id: SID, stop_hook_active: false });
  wantAllow('interactive allows stop');
  run('stop-require-evidence.js', { session_id: SID, stop_hook_active: false }, { UK2_AGENT_MODE: 'implement' });
  wantBlock('agent-mode blocks without sentinel');
  fs.writeFileSync(VERIFY, JSON.stringify({ passed: true, head_commit: HEAD }));
  run('stop-require-evidence.js', { session_id: SID, stop_hook_active: false }, { UK2_AGENT_MODE: 'implement' });
  wantAllow('agent-mode allows with passing sentinel');
  run('stop-require-evidence.js', { session_id: SID, stop_hook_active: true }, { UK2_AGENT_MODE: 'implement' });
  wantAllow('stop_hook_active short-circuit');
  fs.rmSync(VERIFY, { force: true }); fs.rmSync(CAP, { force: true });

  console.log('== stop-require-evidence (configured) ==');
  const stopPayload = { session_id: SID, stop_hook_active: false };
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_STOP_GATE_DISABLE: '1' });
  wantAllow('UK2_STOP_GATE_DISABLE turns gate off');

  fs.writeFileSync(HOOKSENV, 'UK2_STOP_GATE_CMD="true"\n');
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantAllow('passing STOP_GATE_CMD replaces sentinel');

  fs.writeFileSync(HOOKSENV,
    'UK2_STOP_GATE_CMD="echo 3 tests failing; exit 1"\n'
    + 'UK2_STOP_GATE_MESSAGE="Verify must pass for {head}."\n');
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantBlock('failing STOP_GATE_CMD blocks');
  check('custom message fills {head} and carries output',
    OUT.includes(`Verify must pass for ${HEAD}.`) && OUT.includes('3 tests failing'));

  fs.rmSync(CAP, { force: true });
  fs.writeFileSync(HOOKSENV, 'UK2_STOP_GATE_CMD="false"\nUK2_STOP_GATE_MAX_BLOCKS=1\n');
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantBlock('first failure blocks under MAX_BLOCKS=1');
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSENV });
  wantAllow('cap exhausted after MAX_BLOCKS blocks');
  fs.rmSync(HOOKSENV, { force: true });
  fs.rmSync(VERIFY, { force: true }); fs.rmSync(CAP, { force: true });

  console.log('== session-context ==');
  fs.writeFileSync(TICKET, JSON.stringify({
    issue: '123', acceptance_criteria: ['WHEN x THE SYSTEM SHALL y'], out_of_scope: 'billing',
  }));
  run('session-context.js', { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' });
  wantCtx('injects ticket context');
  fs.rmSync(TICKET, { force: true });
  run('session-context.js', { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' });
  wantAllow('no context without ticket');
  check('records session-start baseline', fs.existsSync(path.join(PROJ, '.claude', 'state', `session-${SID}.json`)));

  console.log('== telemetry-posttool ==');
  fs.rmSync(SESS, { force: true });
  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command: 'scripts/test_this Chimera::UnitTest::Foo' },
    tool_response: {
      exit_code: 0,
      stdout: 'ok 1 - a\nok 2 - b\nok 3 - c\nAll tests successful.\nFiles=1, Tests=3,  2 wallclock secs',
      stderr: '',
    },
  });
  let ev = lastEvent('test_run');
  check('test_run logged tests_run=3', ev && ev.tests_run === 3 && ev.passed === 3 && ev.failed === 0);
  check('test_run duration_ms=2000', ev && ev.duration_ms === 2000);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command: 'perl -c lib/Bad.pm' },
    tool_response: { exit_code: 255, stdout: '', stderr: 'syntax error at lib/Bad.pm line 3.' },
  });
  check('tool_failure logged', lastEvent('tool_failure') !== null);
  ev = lastEvent('tool_use');
  check('tool_use ok=false on failure', ev && ev.tool === 'Bash' && ev.ok === false);

  run('telemetry-posttool.js', {
    session_id: SID,
    transcript_path: TRANSCRIPT,
    tool_name: 'Read',
    tool_input: { file_path: 'lib/Foo.pm' },
    tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('tool_use ok=true logged for Read', ev && ev.tool === 'Read' && ev.ok === true);
  check('tool_use carries message tokens', ev && ev.tokens_in === 200 && ev.tokens_out === 80
    && ev.tokens_cache_read === 20 && ev.tokens_cache_created === 0 && ev.message_id === 'msg_test2');
  check('events stamped with user+host', ev && ev.user === 'hooktest@uk2group.com'
    && typeof ev.host === 'string' && ev.host.length > 0);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Skill',
    tool_input: { skill: 'code-review', args: 'my branch' },
    tool_response: {},
  });
  ev = lastEvent('skill_use');
  check('skill_use logged with name+args', ev && ev.skill === 'code-review' && ev.args === 'my branch' && ev.ok === true);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', description: 'Find handlers', model: 'haiku' },
    tool_response: {},
  });
  ev = lastEvent('agent_use');
  check('agent_use model override', ev && ev.agent_type === 'Explore' && ev.model === 'haiku' && ev.model_source === 'override');

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'fixture-pinned', description: 'Pinned agent' },
    tool_response: {},
  });
  ev = lastEvent('agent_use');
  check('agent_use model from agent-def frontmatter', ev && ev.model === 'sonnet' && ev.model_source === 'agent-def');

  run('telemetry-posttool.js', {
    session_id: SID,
    transcript_path: TRANSCRIPT,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'fixture-inherit', description: 'Inheriting agent' },
    tool_response: {},
  });
  ev = lastEvent('agent_use');
  check('agent_use inherit falls through to session model',
    ev && ev.model === 'claude-fable-5' && ev.model_source === 'session');

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Task',
    tool_input: { description: 'Search for usages', prompt: '...' },
    tool_response: {},
  });
  ev = lastEvent('agent_use');
  check('agent_use defaults type, null model without transcript',
    ev && ev.agent_type === 'general-purpose' && ev.model === null && ev.model_source === null);

  console.log('== telemetry shipping ==');
  const failPayload = {
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command: 'perl -c lib/Bad.pm' },
    tool_response: { exit_code: 255, stdout: '', stderr: 'syntax error' },
  };

  // Config absent: hook succeeds, event logged locally, nothing spooled, no noise.
  fs.rmSync(SESS, { force: true }); fs.rmSync(SPOOL, { force: true });
  run('telemetry-posttool.js', failPayload);
  check('shipping skipped cleanly without config',
    RC === 0 && lastEvent('tool_failure') !== null && !fs.existsSync(SPOOL) && ERR.trim() === '');

  // Unreachable ES: hook still exits 0 instantly; the detached shipper spools.
  run('telemetry-posttool.js', failPayload, { UK2_TELEMETRY_CONFIG: path.join(FIXTURES, 'telemetry-unreachable.env') });
  check('hook exit 0 with unreachable ES', RC === 0);
  let spooled = await waitSpoolStable();
  check('failed send spooled to unshipped.jsonl', spooled.includes('"event":"tool_failure"'));

  // Legacy CHIMERA_* config keeps working through the fallback.
  fs.rmSync(SPOOL, { force: true });
  run('telemetry-posttool.js', failPayload, { UK2_TELEMETRY_CONFIG: path.join(FIXTURES, 'telemetry-legacy-chimera.env') });
  check('hook exit 0 with legacy CHIMERA_* config', RC === 0);
  spooled = await waitSpoolStable();
  check('legacy-named config still ships (spools)', spooled.includes('"event":"tool_failure"'));

  console.log('== session-summary (token aggregation) ==');
  fs.writeFileSync(path.join(PROJ, '.claude', 'state', `session-${SID}.json`),
    JSON.stringify({ start_ts: '2026-06-02T00:00:00Z', issue: '123', branch: 'x' }));
  run('session-summary.js', {
    session_id: SID, hook_event_name: 'SessionEnd', end_reason: 'other', transcript_path: TRANSCRIPT,
  });
  ev = lastEvent('session_summary');
  check('session_summary total_tokens=465', ev && ev.total_tokens === 465 && ev.turns === 2);
  check('session_summary counts + identity', ev && ev.tool_failures >= 1
    && ev.user === 'hooktest@uk2group.com' && typeof ev.wall_ms === 'number');
  check('session_summary appended to summaries.jsonl',
    events('session_summary', path.join(PROJ, '.claude', 'telemetry', 'summaries.jsonl')).length === 1);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail === 0 ? 0 : 1);
})();
