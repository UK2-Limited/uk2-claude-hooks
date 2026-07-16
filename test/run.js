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

// CLIs (telemetry-verify) take argv, not stdin; same ambient-env hygiene.
function runCli(script, args) {
  const env = { ...process.env };
  delete env.CI;
  delete env.CLAUDE_PROJECT_DIR;
  for (const k of Object.keys(env)) { if (/^(UK2|CHIMERA)_/.test(k)) delete env[k]; }
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', timeout: 30000, env,
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

  // Rules match the RAW command; only the logged event is path-normalized.
  writeHooksCfg({ dangerousBash: { rules: [{ reason: 'abs path rule', match: [`${PROJ}/secret`] }] } });
  dbRun(`cat ${PROJ}/secret/f`); wantDeny('rule matches raw absolute path');
  const dbs = lastEvent('dangerous_bash_blocked');
  check('dangerous_bash_blocked command is path-normalized', dbs && dbs.command === 'cat secret/f');

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
  check('tool_use model null without transcript', ev && ev.model === null);
  check('tool_use carries the bash command', ev && ev.command === 'perl -c lib/Bad.pm');

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command: `echo ${'x'.repeat(300)}` },
    tool_response: { exit_code: 0, stdout: '', stderr: '' },
  });
  ev = lastEvent('tool_use');
  check('tool_use command truncated to 200 chars on success',
    ev && ev.ok === true && typeof ev.command === 'string' && ev.command.length === 200);
  check('tool_use file_path absent on Bash', ev && ev.file_path === undefined);

  // Path normalization: prefixes under the project dir strip to relative
  // paths, a bare cwd becomes '.', sibling dirs stay untouched, and $HOME
  // folds to '~' — all before truncation.
  const bashOk = (command, extra = {}) => run('telemetry-posttool.js', {
    session_id: SID, tool_name: 'Bash', tool_input: { command },
    tool_response: { exit_code: 0, stdout: '', stderr: '' }, ...extra,
  });
  bashOk(`sed -n 1,5p ${PROJ}/lib/Foo.pm`);
  ev = lastEvent('tool_use');
  check('tool_use command strips project-dir prefix', ev && ev.command === 'sed -n 1,5p lib/Foo.pm');
  bashOk(`cd ${PROJ} && ls`);
  ev = lastEvent('tool_use');
  check('tool_use bare cwd becomes .', ev && ev.command === 'cd . && ls');
  bashOk(`ls ${PROJ}-other/x`);
  ev = lastEvent('tool_use');
  const sibling = `${PROJ}-other/x`.startsWith(`${os.homedir()}/`)
    ? `~${PROJ.slice(os.homedir().length)}-other/x` : `${PROJ}-other/x`;
  check('tool_use sibling dir not mistaken for cwd', ev && ev.command === `ls ${sibling}`);
  bashOk(`cat ${os.homedir()}/elsewhere/f`);
  ev = lastEvent('tool_use');
  check('tool_use $HOME folds to ~', ev && ev.command === 'cat ~/elsewhere/f');
  bashOk('make -C /srv/build/app', { cwd: '/srv/build' });
  ev = lastEvent('tool_use');
  check('tool_use payload cwd is stripped too', ev && ev.command === 'make -C app');

  // file_path on tool_use gets the same normalization as commands.
  const readOk = (file_path) => run('telemetry-posttool.js', {
    session_id: SID, tool_name: 'Read', tool_input: { file_path }, tool_response: {},
  });
  readOk(`${PROJ}/lib/Foo.pm`);
  ev = lastEvent('tool_use');
  check('tool_use file_path strips project-dir prefix', ev && ev.file_path === 'lib/Foo.pm');
  readOk(`${os.homedir()}/elsewhere/notes.md`);
  ev = lastEvent('tool_use');
  check('tool_use file_path $HOME folds to ~', ev && ev.file_path === '~/elsewhere/notes.md');
  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: `${PROJ}/nb/analysis.ipynb` },
    tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('tool_use file_path from notebook_path', ev && ev.file_path === 'nb/analysis.ipynb');

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command: `perl -c ${PROJ}/lib/Bad.pm` },
    tool_response: { exit_code: 255, stdout: '', stderr: 'syntax error.' },
  });
  ev = lastEvent('tool_failure');
  check('tool_failure command is path-normalized', ev && ev.command === 'perl -c lib/Bad.pm');

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command: `prove ${PROJ}/t/foo.t` },
    tool_response: { exit_code: 0, stdout: 'ok 1 - a\nFiles=1, Tests=1,  1 wallclock secs', stderr: '' },
  });
  ev = lastEvent('test_run');
  check('test_run command and target are path-normalized',
    ev && ev.command === 'prove t/foo.t' && ev.target === 't/foo.t');

  run('telemetry-posttool.js', {
    session_id: SID,
    transcript_path: TRANSCRIPT,
    tool_name: 'Read',
    tool_input: { file_path: 'lib/Foo.pm' },
    tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('tool_use ok=true logged for Read', ev && ev.tool === 'Read' && ev.ok === true);
  check('tool_use command absent on non-Bash tools', ev && ev.command === undefined);
  check('tool_use file_path logged for Read', ev && ev.file_path === 'lib/Foo.pm');
  // The transcript tail ends with an isSidechain entry (9999s) — the pick must
  // skip it and land on msg_test2's FINAL entry (out=80, not the partial 30).
  check('tool_use carries last main-loop message tokens (skips sidechain)',
    ev && ev.tokens_in === 200 && ev.tokens_out === 80
    && ev.tokens_cache_read === 20 && ev.tokens_cache_created === 0 && ev.message_id === 'msg_test2');
  check('tool_use carries the issuing message model', ev && ev.model === 'claude-fable-5');
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
  check('main-loop events carry subagent=false agent_id=null',
    ev && ev.subagent === false && ev.agent_id === null);

  console.log('== sub-agent attribution ==');
  // A sub-agent's tool call arrives with agent_id/agent_type in the payload and
  // the PARENT's transcript_path; its own transcript lives under
  // <transcript minus .jsonl>/subagents/. Tokens must come from that file, not
  // from the main loop's last assistant message.
  const AGTRANS = path.join(PROJ, 'agent-transcript.jsonl');
  fs.copyFileSync(TRANSCRIPT, AGTRANS);
  const AGSUB = path.join(PROJ, 'agent-transcript', 'subagents');
  fs.mkdirSync(path.join(AGSUB, 'workflows', 'wf_1'), { recursive: true });
  fs.writeFileSync(path.join(AGSUB, 'agent-sub42.jsonl'),
    '{"type":"assistant","message":{"id":"msg_sub1","usage":{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}}}\n');
  run('telemetry-posttool.js', {
    session_id: SID, transcript_path: AGTRANS, agent_id: 'sub42', agent_type: 'Explore',
    tool_name: 'Read', tool_input: { file_path: 'lib/Foo.pm' }, tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('sub-agent tool_use marked subagent=true with agent_id',
    ev && ev.subagent === true && ev.agent_id === 'sub42');
  check('sub-agent tool_use tokens from its own transcript',
    ev && ev.tokens_in === 7 && ev.tokens_out === 11 && ev.tokens_cache_read === 3
    && ev.message_id === 'msg_sub1');

  // Workflow fan-out agents nest deeper — the transcript is found by walking.
  fs.writeFileSync(path.join(AGSUB, 'workflows', 'wf_1', 'agent-nest7.jsonl'),
    '{"type":"assistant","message":{"id":"msg_nest1","usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
  run('telemetry-posttool.js', {
    session_id: SID, transcript_path: AGTRANS, agent_id: 'nest7', agent_type: 'workflow',
    tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: { exit_code: 0 },
  });
  ev = lastEvent('tool_use');
  check('nested workflow agent transcript found for tokens',
    ev && ev.agent_id === 'nest7' && ev.tokens_in === 5 && ev.tokens_out === 9
    && ev.message_id === 'msg_nest1');

  // Unknown agent transcript: null tokens, never the main loop's numbers.
  run('telemetry-posttool.js', {
    session_id: SID, transcript_path: AGTRANS, agent_id: 'ghost', agent_type: 'Explore',
    tool_name: 'Read', tool_input: { file_path: 'lib/Foo.pm' }, tool_response: {},
  });
  ev = lastEvent('tool_use');
  check('missing sub-agent transcript logs no tokens, not main-loop tokens',
    ev && ev.subagent === true && ev.message_id === null && !ev.tokens_in && !ev.tokens_out);

  // Agent spawn: tool_response.agentId ties the spawn to the worker's events.
  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', description: 'x', model: 'haiku' },
    tool_response: { agentId: 'sub42', status: 'async_launched' },
  });
  ev = lastEvent('agent_use');
  check('agent_use records spawned_agent_id', ev && ev.spawned_agent_id === 'sub42');

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
  check('edit trusts hunks when a Write response carries a non-empty patch',
    ev && ev.tool === 'Write' && ev.file_path === 'docs/new.md'
    && ev.lines_added === 2 && ev.lines_removed === 0);
  check('edit permission_mode null when absent', ev && ev.permission_mode === null);

  // Real Write-create payload: Claude Code sends an EMPTY structuredPatch for
  // new files ({type:'create', content, originalFile:null}) — lines must come
  // from the accepted content, not the (zero) hunks.
  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Write',
    tool_input: { file_path: 'src/new-file.c', content: 'a\nb\nc\n' },
    tool_response: {
      type: 'create',
      filePath: 'src/new-file.c',
      content: 'a\nb\nc\n',
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
  });
  ev = lastEvent('edit');
  check('Write create with empty patch counts lines from content',
    ev && ev.tool === 'Write' && ev.file_path === 'src/new-file.c'
    && ev.lines_added === 3 && ev.lines_removed === 0);

  run('telemetry-posttool.js', {
    session_id: SID,
    tool_name: 'Write',
    tool_input: { file_path: 'src/one-liner.txt', content: 'no trailing newline' },
    tool_response: { type: 'create', content: 'no trailing newline', structuredPatch: [], originalFile: null },
  });
  ev = lastEvent('edit');
  check('Write create counts last line without trailing newline',
    ev && ev.lines_added === 1 && ev.lines_removed === 0);

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
  // The fixture sets three traps the raw per-line sum would fall into:
  // msg_test2 appears twice with growing usage (dedupe: out=80, not 30+80),
  // an isSidechain entry carries 9999s (excluded from the main loop), and
  // msg_test1 has only the NESTED cache_creation shape (3+2=5).
  check('session_summary dedupes repeated message ids (out=130, not 160)',
    ev && ev.input_tokens === 300 && ev.output_tokens === 130);
  check('session_summary excludes inline sidechain usage',
    ev && ev.cache_read_input_tokens === 30 && ev.input_tokens === 300);
  check('session_summary sums nested cache_creation shape (cc=5)',
    ev && ev.cache_creation_input_tokens === 5);
  check('session_summary carries model, est_cost_usd dropped',
    ev && ev.model === 'claude-fable-5' && !('est_cost_usd' in ev));
  check('session_summary counts + identity', ev && ev.tool_failures >= 1
    && ev.user === 'hooktest@uk2group.com' && ev.repo === 'uk2group/scratch-repo'
    && typeof ev.wall_ms === 'number');
  check('session_summary appended to summaries.jsonl',
    events('session_summary', path.join(PROJ, '.claude', 'telemetry', 'summaries.jsonl')).length === 1);
  check('session_summary sub-agent fields zero without subagents dir',
    ev && ev.total_subagent_tokens === 0 && ev.total_subagent_cache_tokens === 0);
  check('session_summary carries subagent=false agent_id=null',
    ev && ev.subagent === false && ev.agent_id === null);

  // Sub-agent transcripts live under <transcript-path minus .jsonl>/subagents/
  // (possibly nested, e.g. subagents/workflows/wf_*/). Their usage folds into
  // total_tokens / total_cache_tokens and is broken out as total_subagent_*.
  const SUBTRANS = path.join(PROJ, 'sub-transcript.jsonl');
  fs.copyFileSync(TRANSCRIPT, SUBTRANS);
  const SUBDIR = path.join(PROJ, 'sub-transcript', 'subagents');
  fs.mkdirSync(path.join(SUBDIR, 'workflows', 'wf_1'), { recursive: true });
  // agent-1: a streamed message repeated with growing usage (dedupe keeps the
  // last entry: 1000+180), plus an id-less usage entry that must count on its
  // own (synthetic key: +20). File total: tokens 1200, cache 75.
  fs.writeFileSync(path.join(SUBDIR, 'agent-1.jsonl'),
    '{"type":"assistant","message":{"id":"msg_sub_a","usage":{"input_tokens":1000,"output_tokens":150,"cache_read_input_tokens":40,"cache_creation_input_tokens":25}}}\n'
    + '{"type":"assistant","message":{"id":"msg_sub_a","usage":{"input_tokens":1000,"output_tokens":180,"cache_read_input_tokens":50,"cache_creation_input_tokens":25}}}\n'
    + '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n'
    + '{"type":"user","message":{"role":"user","content":"x"}}\n'
    + 'not json\n');
  fs.writeFileSync(path.join(SUBDIR, 'workflows', 'wf_1', 'agent-2.jsonl'),
    '{"type":"assistant","message":{"usage":{"input_tokens":300,"output_tokens":40,"cache_read_input_tokens":5,"cache_creation_input_tokens":0}}}\n');
  fs.writeFileSync(path.join(SUBDIR, 'agent-1.meta.json'), '{"message":{"usage":{"input_tokens":9999}}}');
  run('session-summary.js', {
    session_id: SID, hook_event_name: 'SessionEnd', end_reason: 'other', transcript_path: SUBTRANS,
  });
  ev = lastEvent('session_summary');
  check('session_summary folds sub-agent tokens (subagent=1540, total=1970)',
    ev && ev.total_subagent_tokens === 1540 && ev.total_tokens === 430 + 1540);
  check('session_summary folds sub-agent cache tokens (subagent=80, total=115)',
    ev && ev.total_subagent_cache_tokens === 80 && ev.total_cache_tokens === 35 + 80);
  check('session_summary main-loop token fields unchanged by sub-agents',
    ev && ev.input_tokens === 300 && ev.output_tokens === 130 && ev.turns === 2);

  console.log('== telemetry-verify (CLI) ==');
  // Hermetic stand-in for ~/.claude/projects/<flattened-path>/ — the CLI takes
  // --projects-dir so the tests never look at a real transcript store. The
  // last summary in the session file was computed from SUBTRANS + SUBDIR, so
  // copying both makes the recompute match exactly.
  const FAKEPROJ = path.join(PROJ, 'fake-projects');
  fs.mkdirSync(FAKEPROJ, { recursive: true });
  fs.copyFileSync(SUBTRANS, path.join(FAKEPROJ, `${SID}.jsonl`));
  fs.cpSync(path.join(PROJ, 'sub-transcript', 'subagents'),
    path.join(FAKEPROJ, SID, 'subagents'), { recursive: true });
  fs.rmSync(SPOOL, { force: true });
  const sessBefore = fs.readFileSync(SESS, 'utf8');

  runCli('telemetry-verify.js', [PROJ, '--projects-dir', FAKEPROJ]);
  check('verify: clean project exits 0', RC === 0);
  check('verify: recompute matches the last summary',
    OUT.includes('all token fields match'));
  check('verify: checks summaries.jsonl consistency',
    OUT.includes('summaries-consistency') && OUT.includes('present in both places'));
  check('verify: read-only (session file untouched, no spool)',
    fs.readFileSync(SESS, 'utf8') === sessBefore && !fs.existsSync(SPOOL));

  // A doctored summary must be caught, exit 1, and name the bad field.
  // tool_calls: 0 because the fabricated session file carries no tool_use.
  const goodSummary = lastEvent('session_summary');
  const BADSESS = path.join(PROJ, '.claude', 'telemetry', 'sessions', 'hooktest-bad.jsonl');
  fs.writeFileSync(BADSESS, `${JSON.stringify({
    ...goodSummary, session_id: 'hooktest-bad', tool_calls: 0, output_tokens: 999999, total_tokens: 999999,
  })}\n`);
  fs.copyFileSync(SUBTRANS, path.join(FAKEPROJ, 'hooktest-bad.jsonl'));
  fs.cpSync(path.join(PROJ, 'sub-transcript', 'subagents'),
    path.join(FAKEPROJ, 'hooktest-bad', 'subagents'), { recursive: true });
  runCli('telemetry-verify.js', [PROJ, '--session', 'hooktest-bad', '--projects-dir', FAKEPROJ]);
  check('verify: doctored summary exits 1 naming the field',
    RC === 1 && OUT.includes('output_tokens: logged 999999'));

  runCli('telemetry-verify.js', [PROJ, '--session', 'hooktest-bad', '--projects-dir', FAKEPROJ, '--json']);
  let vr = null;
  try { vr = JSON.parse(OUT); } catch { /* check fails below */ }
  check('verify: --json mirrors checks and exit code',
    RC === 1 && vr && Array.isArray(vr.checks) && vr.exit === 1 && vr.counts.mismatch >= 1);

  // A pruned transcript is a skip, not a failure.
  const GHOSTSESS = path.join(PROJ, '.claude', 'telemetry', 'sessions', 'hooktest-ghost.jsonl');
  fs.writeFileSync(GHOSTSESS, `${JSON.stringify({
    ...goodSummary, session_id: 'hooktest-ghost', tool_calls: 0,
  })}\n`);
  runCli('telemetry-verify.js', [PROJ, '--session', 'hooktest-ghost', '--projects-dir', FAKEPROJ]);
  check('verify: missing transcript skips, exits 0',
    RC === 0 && OUT.includes('skip') && OUT.includes('transcript not found'));

  runCli('telemetry-verify.js', [PROJ, '--session', 'no-such-session', '--projects-dir', FAKEPROJ]);
  check('verify: unknown session exits 2', RC === 2);
  runCli('telemetry-verify.js', [PROJ, '--bogus-flag']);
  check('verify: unknown flag exits 2 with usage', RC === 2 && ERR.includes('usage:'));
  fs.rmSync(BADSESS, { force: true });
  fs.rmSync(GHOSTSESS, { force: true });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail === 0 ? 0 : 1);
})();
