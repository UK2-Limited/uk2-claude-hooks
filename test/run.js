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
// Scratch hooks.json for the configured-gate tests (passed via UK2_HOOKS_CONFIG).
const HOOKSJSON = path.join(PROJ, 'hooks-test.json');
function writeHooksCfg(obj) { fs.writeFileSync(HOOKSJSON, JSON.stringify(obj)); }

// --- harness ---
let pass = 0;
let fail = 0;
let skipped = 0;
let OUT = '';
let ERR = '';
let RC = 0;

function run(script, payload, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: PROJ, UK2_TELEMETRY_CONFIG: '/nonexistent-telemetry.json' };
  // Never inherit ambient agent-mode / telemetry state from the caller's shell.
  for (const k of ['CI', 'UK2_AGENT_MODE', 'CHIMERA_AGENT_MODE', 'UK2_ALLOW_DANGEROUS',
    'CHIMERA_ALLOW_DANGEROUS', 'UK2_ISSUE', 'CHIMERA_ISSUE', 'UK2_TELEMETRY_DISABLE',
    'CHIMERA_TELEMETRY_DISABLE', 'CHIMERA_TELEMETRY_CONFIG', 'UK2_TELEMETRY_SPOOL',
    'CHIMERA_TELEMETRY_SPOOL', 'UK2_DEVENV_DIR', 'CHIMERA_DEVENV_DIR']) delete env[k];
  // Ditto for any ambient gate config (config-path vars and kill switches).
  for (const k of Object.keys(env)) {
    if (/^(UK2|CHIMERA)_(HOOKS_CONFIG|COMPILE_CHECK|TEST_INTEGRITY|STOP_GATE|PROTECTED_PATHS)/.test(k)) delete env[k];
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
  console.log('== protected-paths ==');
  const ppEdit = (fp, tool = 'Write') => ({ session_id: SID, tool_name: tool, tool_input: { file_path: fp } });
  const ppRun = (payload, extra = {}) => run('protected-paths.js', payload, { UK2_HOOKS_CONFIG: HOOKSJSON, ...extra });

  // No protectedPaths config: inert. The scratch project HAS a legacy
  // protected-paths.txt denying this very path — proves the txt is dead.
  run('protected-paths.js', ppEdit('conf/production/all/x.yml'));
  wantAllow('inert without protectedPaths config (legacy txt no longer read)');
  check('txt migration nag on stderr', ERR.includes('no longer read'));

  writeHooksCfg({ protectedPaths: {
    deny: ['conf/production/', '**/.env', '**/secrets/**'],
    warn: ['database/structure/'],
  } });
  ppRun(ppEdit('conf/production/all/x.yml')); wantDeny('deny conf/production');
  ppRun(ppEdit('service/.env')); wantDeny('deny **/.env');
  ppRun(ppEdit('app/secrets/key.pem')); wantDeny('deny **/secrets/**');
  const pd = lastEvent('protected_deny');
  check('protected_deny logged with path+rule+tool',
    pd && pd.path === 'app/secrets/key.pem' && pd.rule === '**/secrets/**' && pd.tool === 'Write');
  ppRun({ session_id: SID, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'conf/production/nb.ipynb' } });
  wantDeny('deny follows notebook_path too');
  ppRun(ppEdit('database/structure/widgets.sql'));
  wantAllow('warn rule allows');
  check('warn advisory on stderr', ERR.includes('WARNING'));
  check('protected_warn logged', lastEvent('protected_warn') !== null);
  ppRun(ppEdit('lib/Foo.pm')); wantAllow('unmatched path allowed');
  ppRun(ppEdit('conf/production/x.yml'), { UK2_PROTECTED_PATHS_DISABLE: '1' });
  wantAllow('UK2_PROTECTED_PATHS_DISABLE turns gate off');
  writeHooksCfg({ protectedPaths: { disable: true, deny: ['conf/production/'] } });
  ppRun(ppEdit('conf/production/x.yml')); wantAllow('protectedPaths.disable turns gate off');
  fs.rmSync(HOOKSJSON, { force: true });

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

  console.log('== block-dangerous-bash (configured rules) ==');
  const dbRun = (command, extra = {}) => run('block-dangerous-bash.js', bash(command), { UK2_HOOKS_CONFIG: HOOKSJSON, ...extra });
  writeHooksCfg({ dangerousBash: { rules: [
    { reason: 'no shutdowns', match: ['(^|\\s)shutdown(\\s|$)'] },
    { reason: 'no prod deletes', match: ['DELETE\\s+FROM'], noMatch: ['test'] },
  ] } });
  dbRun('sudo shutdown now'); wantDeny('configured rule denies');
  check('deny carries configured reason', OUT.includes('no shutdowns'));
  dbRun('mysql -e "DELETE FROM users"'); wantDeny('match+noMatch rule denies');
  dbRun('mysql -e "DELETE FROM test_users"'); wantAllow('noMatch exempts');
  dbRun('git push --force origin main'); wantAllow('configured rules replace built-ins');
  dbRun('sudo shutdown now', { UK2_ALLOW_DANGEROUS: '1' }); wantAllow('human override still applies with config');
  const dbe = lastEvent('dangerous_bash_blocked');
  check('dangerous_bash_blocked carries configured reason', dbe && dbe.reason === 'no prod deletes');

  writeHooksCfg({ dangerousBash: { rules: [
    { reason: 'broken', match: ['('] },
    { reason: 'no shutdowns', match: ['shutdown'] },
  ] } });
  dbRun('shutdown now'); wantDeny('invalid regex skips that rule only');
  check('invalid-rule note on stderr', ERR.includes('rule 1'));

  writeHooksCfg({ dangerousBash: { disable: true } });
  dbRun('rm -rf /'); wantAllow('dangerousBash.disable turns gate off');

  // hooks.json.example spells out the built-in defaults — it must not drift.
  fs.copyFileSync(path.join(ROOT, 'hooks.json.example'), HOOKSJSON);
  dbRun('rm -rf /'); wantDeny('example config: rm floor matches built-in');
  dbRun('git push --force origin master'); wantDeny('example config: force-push still denied');
  dbRun('mysql -e "TRUNCATE TABLE test_widgets"'); wantAllow('example config: TRUNCATE test still allowed');
  ppRun(ppEdit('conf/production/all/x.yml')); wantDeny('example config: deny conf/production');
  ppRun(ppEdit('database/structure/widgets.sql')); wantAllow('example config: warn rule allows');
  fs.rmSync(HOOKSJSON, { force: true });

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
  writeHooksCfg({
    testIntegrity: {
      fileRe: '\\.test\\.js$',
      assertRe: '\\bexpect\\s*\\(',
      skipRe: '\\b(it|test)\\.skip\\b',
    },
  });
  run('test-integrity.js', jsDrop, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantDeny('configured assertRe denies js assertion drop');
  run('test-integrity.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 'src/foo.test.js', old_string: "it('x', f);", new_string: "it.skip('x', f);" },
  }, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantDeny('configured skipRe denies introduced skip');
  run('test-integrity.js', editDrop, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('fileRe override replaces the perl heuristic');
  run('test-integrity.js', editDrop, { UK2_AGENT_MODE: 'implement', UK2_TEST_INTEGRITY_DISABLE: '1' });
  wantAllow('UK2_TEST_INTEGRITY_DISABLE turns hook off');
  fs.rmSync(HOOKSJSON, { force: true });

  console.log('== test-integrity (repo\'s own validation config) ==');
  // .claude/validation/hooks.json pins testIntegrity to this suite's own harness
  // idioms (check/wantDeny/wantBlock/wantAllow/wantCtx) — it must not drift.
  fs.copyFileSync(path.join(ROOT, '.claude', 'validation', 'hooks.json'), HOOKSJSON);
  const tiRepo = (tool_input, extra = {}) => run('test-integrity.js',
    { session_id: SID, tool_name: 'Edit', tool_input },
    { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON, ...extra });
  tiRepo({ file_path: 'test/run.js', old_string: "check('a', x);\nwantDeny('b');", new_string: "check('a', x);" });
  wantDeny('repo config: harness assertion drop denied');
  tiRepo({ file_path: 'test/run.js', old_string: "wantBlock('x');", new_string: "wantBlock('x'); // wantAllow('y');" });
  wantDeny('repo config: commented-out assertion denied');
  tiRepo({ file_path: 'test/run.js', old_string: "check('a', 1);", new_string: "check('a', 1);\nwantCtx('b');" });
  wantAllow('repo config: added assertion allowed');
  tiRepo({ file_path: 'test/run.js', old_string: "check('a', 1);", new_string: "check('a', 1);\nskip('docker unavailable');" });
  wantAllow('repo config: legitimate skip() helper not flagged');
  tiRepo({ file_path: 'scripts/foo.js', old_string: "check('a', x);\nwantDeny('b');", new_string: "check('a', x);" });
  wantAllow('repo config: fileRe scopes gate to test/');
  tiRepo({ file_path: 'test/run.js', old_string: "check('a', x);\nwantDeny('b');", new_string: "check('a', x);" },
    { UK2_AGENT_MODE: '' });
  wantAllow('repo config: interactive session warns but allows');
  fs.rmSync(HOOKSJSON, { force: true });

  console.log('== compile-check (skip paths) ==');
  run('compile-check.js', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'lib/Foo.pm' } },
    { UK2_DEVENV_DIR: '/nonexistent-devenv' });
  wantAllow('skip when api down');
  run('compile-check.js', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'README.md' } });
  wantAllow('ignore non-perl file');

  console.log('== compile-check (configured steps) ==');
  const ccEdit = (fp) => ({ session_id: SID, tool_name: 'Edit', tool_input: { file_path: fp } });
  const ccRun = (payload, extra = {}) => run('compile-check.js', payload, { UK2_HOOKS_CONFIG: HOOKSJSON, ...extra });

  writeHooksCfg({ compileCheck: { steps: [
    { match: '\\.pm$', cmd: 'echo compile error in {file} >&2; exit 2' },
  ] } });
  ccRun(ccEdit('lib/Foo.pm'));
  wantBlock('failing step blocks');
  check('block carries command output', OUT.includes('compile error in'));
  const cf = lastEvent('compile_fail');
  check('compile_fail logged with step+cmd', cf && cf.step === 1 && cf.file === 'lib/Foo.pm' && typeof cf.cmd === 'string');

  writeHooksCfg({ compileCheck: { steps: [{ match: '\\.pm$', cmd: 'true' }] } });
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('passing step allows');

  writeHooksCfg({ compileCheck: { steps: [{ match: '\\.ts$', cmd: 'exit 1' }] } });
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('non-matching step skipped');

  writeHooksCfg({ compileCheck: { steps: [{ precheck: 'false', cmd: 'exit 1' }] } });
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('failed precheck skips quietly');

  writeHooksCfg({ compileCheck: { steps: [
    { cmd: 'echo WARNING: unresolved reference', errorRe: 'unresolved reference' },
  ] } });
  ccRun(ccEdit('lib/Foo.pm')); wantBlock('errorRe match blocks despite exit 0');

  writeHooksCfg({ compileCheck: { steps: [{ cmd: 'true' }, { cmd: 'exit 3' }] } });
  ccRun(ccEdit('lib/Foo.pm')); wantBlock('second step failure blocks');

  writeHooksCfg({ compileCheck: { steps: [{ match: '\\.md$', cmd: 'exit 1' }] } });
  ccRun(ccEdit('docs/README.md')); wantBlock('configured steps reach beyond .pm/.pl');

  // 25 steps: only the last one matches — proves the old 1..20 cap is gone.
  writeHooksCfg({ compileCheck: { steps: [
    ...Array.from({ length: 24 }, () => ({ match: '\\.nomatch$', cmd: 'true' })),
    { match: '\\.pm$', cmd: 'echo step25 fails >&2; exit 1' },
  ] } });
  ccRun(ccEdit('lib/Foo.pm'));
  wantBlock('step beyond the old 20-step cap still runs');
  const cf25 = lastEvent('compile_fail');
  check('compile_fail step numbered by array position', cf25 && cf25.step === 25);

  writeHooksCfg({ compileCheck: { steps: [] } });
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('explicit empty steps means no checks');

  writeHooksCfg({ compileCheck: { steps: [{ cmd: 'exit 1' }], disable: true } });
  ccRun(ccEdit('lib/Foo.pm')); wantAllow('compileCheck.disable turns hook off');

  writeHooksCfg({ compileCheck: { steps: [{ cmd: 'exit 1' }] } });
  ccRun(ccEdit('lib/Foo.pm'), { UK2_COMPILE_CHECK_DISABLE: '1' });
  wantAllow('UK2_COMPILE_CHECK_DISABLE turns hook off');
  fs.rmSync(HOOKSJSON, { force: true });

  const DEFHOOKSJSON = path.join(PROJ, '.claude', 'validation', 'hooks.json');
  fs.writeFileSync(DEFHOOKSJSON, JSON.stringify({ compileCheck: { steps: [{ cmd: 'exit 1' }] } }));
  run('compile-check.js', ccEdit('lib/Foo.pm'));
  wantBlock('default .claude/validation/hooks.json is picked up');
  fs.rmSync(DEFHOOKSJSON, { force: true });

  // Legacy env-format config is deliberately ignored (with a stderr nag).
  const LEGACYHOOKS = path.join(PROJ, '.claude', 'validation', 'hooks.env');
  fs.writeFileSync(LEGACYHOOKS, 'UK2_COMPILE_CHECK_1_CMD="exit 1"\n');
  run('compile-check.js', ccEdit('docs/README.md'));
  wantAllow('legacy hooks.env is no longer read');
  check('migration nag on stderr', ERR.includes('no longer read'));
  fs.rmSync(LEGACYHOOKS, { force: true });

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

  writeHooksCfg({ stopGate: { cmds: ['true'] } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('passing stopGate.cmds replaces sentinel');

  writeHooksCfg({ stopGate: { cmds: 'true' } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('bare-string cmds is tolerated');

  fs.rmSync(CAP, { force: true });
  writeHooksCfg({ stopGate: { cmds: ['true', 'true'] } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('all cmds passing allows stop');

  writeHooksCfg({ stopGate: {
    cmds: ['echo 3 tests failing; exit 1'],
    message: 'Verify must pass for {head}.',
  } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantBlock('failing cmd blocks');
  check('custom message fills {head} and carries output',
    OUT.includes(`Verify must pass for ${HEAD}.`) && OUT.includes('3 tests failing'));

  fs.rmSync(CAP, { force: true });
  writeHooksCfg({ stopGate: { cmds: ['true', 'echo lint broke; exit 1'] } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantBlock('second cmd failure blocks');
  check('block names the failing command and its output',
    OUT.includes('echo lint broke') && OUT.includes('lint broke'));

  fs.rmSync(CAP, { force: true });
  writeHooksCfg({ stopGate: { cmds: ['false'], maxBlocks: 1 } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantBlock('first failure blocks under maxBlocks=1');
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('cap exhausted after maxBlocks blocks');

  fs.rmSync(CAP, { force: true });
  writeHooksCfg({ stopGate: { cmds: ['false'], disable: true } });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('stopGate.disable turns gate off');
  fs.rmSync(HOOKSJSON, { force: true });
  fs.rmSync(VERIFY, { force: true }); fs.rmSync(CAP, { force: true });

  console.log('== broken hooks.json fails open ==');
  fs.writeFileSync(HOOKSJSON, '{ nope');
  ccRun(ccEdit('lib/Foo.pm'));
  wantAllow('compile-check skips on malformed hooks.json');
  check('invalid-JSON note on stderr', ERR.includes('invalid JSON'));
  run('test-integrity.js', editDrop, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('test-integrity skips on malformed hooks.json');
  fs.rmSync(CAP, { force: true });
  run('stop-require-evidence.js', stopPayload, { UK2_AGENT_MODE: 'implement', UK2_HOOKS_CONFIG: HOOKSJSON });
  wantAllow('stop gate skips on malformed hooks.json');
  ppRun(ppEdit('conf/production/x.yml'));
  wantAllow('protected-paths skips on malformed hooks.json');
  dbRun('rm -rf /');
  wantDeny('dangerous-bash keeps its built-in floor on malformed hooks.json');
  fs.rmSync(HOOKSJSON, { force: true });
  fs.rmSync(CAP, { force: true });

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
  check('repo falls back to folder basename (no remote)', ev && ev.repo === path.basename(PROJ));

  gitP('remote', 'add', 'origin', 'git@github.com:uk2group/scratch-repo.git');
  run('telemetry-posttool.js', {
    session_id: SID, tool_name: 'Read', tool_input: { file_path: 'lib/Foo.pm' }, tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('repo parsed from ssh origin', ev && ev.repo === 'uk2group/scratch-repo');

  gitP('remote', 'set-url', 'origin', 'https://github.com/uk2group/scratch-repo.git');
  run('telemetry-posttool.js', {
    session_id: SID, tool_name: 'Read', tool_input: { file_path: 'lib/Foo.pm' }, tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('repo parsed from https origin', ev && ev.repo === 'uk2group/scratch-repo');

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

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Edit',
    permission_mode: 'acceptEdits',
    tool_input: { file_path: path.join(PROJ, 'lib/Foo.pm'), old_string: 'a', new_string: 'b' },
    tool_response: {
      filePath: path.join(PROJ, 'lib/Foo.pm'),
      structuredPatch: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' ctx', '-old', '+new', '+more', ' tail'] },
        { oldStart: 9, oldLines: 2, newStart: 10, newLines: 1, lines: ['-gone', ' keep'] },
      ],
      userModified: false,
    },
  });
  ev = lastEvent('edit');
  check('edit counts +/- across hunks, path repo-relative',
    ev && ev.tool === 'Edit' && ev.file_path === 'lib/Foo.pm'
    && ev.lines_added === 2 && ev.lines_removed === 2);
  check('edit carries permission_mode', ev && ev.permission_mode === 'acceptEdits');

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Write',
    tool_input: { file_path: 'docs/new.md', content: 'a\nb\n' },
    tool_response: {
      type: 'create',
      filePath: 'docs/new.md',
      content: 'a\nb\n',
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
    },
  });
  ev = lastEvent('edit');
  check('edit logged for Write create',
    ev && ev.tool === 'Write' && ev.file_path === 'docs/new.md'
    && ev.lines_added === 2 && ev.lines_removed === 0);
  check('edit permission_mode null when absent', ev && ev.permission_mode === null);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: 'analysis/nb.ipynb', new_source: 'x = 1' },
    tool_response: {},
  });
  ev = lastEvent('edit');
  check('edit null counts without structuredPatch, notebook_path used',
    ev && ev.tool === 'NotebookEdit' && ev.file_path === 'analysis/nb.ipynb'
    && ev.lines_added === null && ev.lines_removed === null);

  let editsBefore = events('edit').length;
  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 'lib/Foo.pm', old_string: 'x', new_string: 'y' },
    tool_response: { error: 'String to replace not found' },
  });
  check('failed edit emits no edit event (tool_failure covers it)',
    events('edit').length === editsBefore && lastEvent('tool_failure') !== null);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 'lib/Foo.pm', old_string: 'a', new_string: 'b' },
    tool_response: { filePath: 'lib/Foo.pm', structuredPatch: 'garbage' },
  });
  wantAllow('edit fail-open on non-array structuredPatch');
  ev = lastEvent('edit');
  check('edit null counts on non-array structuredPatch',
    ev && ev.lines_added === null && ev.lines_removed === null);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: { file_path: 'lib/Foo.pm', old_string: 'a', new_string: 'b' },
    tool_response: { structuredPatch: [null, { lines: 'nope' }, { lines: ['+ok', 42] }] },
  });
  wantAllow('edit fail-open on junk inside structuredPatch');
  ev = lastEvent('edit');
  check('edit skips junk hunks/lines, still counts strings',
    ev && ev.lines_added === 1 && ev.lines_removed === 0);

  editsBefore = events('edit').length;
  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Edit',
    tool_input: {},
    tool_response: { structuredPatch: [] },
  });
  check('edit skipped when no file path in tool_input', events('edit').length === editsBefore);

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
  run('telemetry-posttool.js', failPayload, { UK2_TELEMETRY_CONFIG: path.join(FIXTURES, 'telemetry-unreachable.json') });
  check('hook exit 0 with unreachable ES', RC === 0);
  let spooled = await waitSpoolStable();
  check('failed send spooled to unshipped.jsonl', spooled.includes('"event":"tool_failure"'));

  // Legacy CHIMERA_* env vars keep working through the envc() fallback
  // (the base env's UK2_TELEMETRY_CONFIG is blanked so the twin can win).
  fs.rmSync(SPOOL, { force: true });
  run('telemetry-posttool.js', failPayload, {
    UK2_TELEMETRY_CONFIG: '',
    CHIMERA_TELEMETRY_CONFIG: path.join(FIXTURES, 'telemetry-unreachable.json'),
  });
  check('hook exit 0 with CHIMERA_-named config path', RC === 0);
  spooled = await waitSpoolStable();
  check('CHIMERA_* env-var fallback still ships (spools)', spooled.includes('"event":"tool_failure"'));

  // Malformed config.json: shipping silently off, nothing spooled, no crash.
  const BADTELE = path.join(PROJ, 'bad-telemetry.json');
  fs.writeFileSync(BADTELE, '{ nope');
  fs.rmSync(SPOOL, { force: true });
  run('telemetry-posttool.js', failPayload, { UK2_TELEMETRY_CONFIG: BADTELE });
  check('hook exit 0 with malformed telemetry config', RC === 0);
  await sleep(500);
  check('malformed telemetry config spools nothing', !fs.existsSync(SPOOL));
  fs.rmSync(BADTELE, { force: true });

  // Legacy config.env alone: ignored, but the foreground hook nags on stderr.
  const LEGACYTELE = path.join(PROJ, '.claude', 'telemetry', 'config.env');
  fs.writeFileSync(LEGACYTELE, 'UK2_TELEMETRY_ES_URL="http://127.0.0.1:9"\n');
  fs.rmSync(SPOOL, { force: true });
  run('telemetry-posttool.js', failPayload, { UK2_TELEMETRY_CONFIG: '' });
  check('legacy config.env is no longer read (exit 0, nothing spooled, nag)',
    RC === 0 && !fs.existsSync(SPOOL) && ERR.includes('no longer read'));
  fs.rmSync(LEGACYTELE, { force: true });

  console.log('== session-summary (token aggregation) ==');
  fs.writeFileSync(path.join(PROJ, '.claude', 'state', `session-${SID}.json`),
    JSON.stringify({ start_ts: '2026-06-02T00:00:00Z', issue: '123', branch: 'x' }));
  run('session-summary.js', {
    session_id: SID, hook_event_name: 'SessionEnd', end_reason: 'other', transcript_path: TRANSCRIPT,
  });
  ev = lastEvent('session_summary');
  check('session_summary total_tokens=430 total_cache_tokens=35',
    ev && ev.total_tokens === 430 && ev.total_cache_tokens === 35 && ev.turns === 2);
  check('session_summary counts + identity', ev && ev.tool_failures >= 1
    && ev.user === 'hooktest@uk2group.com' && ev.repo === 'uk2group/scratch-repo'
    && typeof ev.wall_ms === 'number');
  check('session_summary appended to summaries.jsonl',
    events('session_summary', path.join(PROJ, '.claude', 'telemetry', 'summaries.jsonl')).length === 1);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail === 0 ? 0 : 1);
})();
