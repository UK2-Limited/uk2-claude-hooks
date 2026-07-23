'use strict';
// cmdsplit: best-effort shell-aware splitting of Bash commands for telemetry
// aggregation. splitCommand(cmd) -> { segments, programs }:
//   segments — the chain cut at top-level `;` `;;` `&&` `||` `&` and newlines
//     (quote-aware; a pipeline stays one segment). Max 20, each 200 chars.
//   programs — one entry per pipeline stage, in scan order: the program name
//     plus a subcommand for known multi-word tools (`git show`, `gh pr view`).
//     Contents of `$(...)`, backticks, `<(...)`/`>(...)` and `(...)` subshells
//     are recursed one level for programs (they never add segments). Max 30.
// Known limitations (best effort, never worth failing over): heredoc bodies
// end the scan at the first newline after `<<`, and an argument to a wrapper
// flag (`sudo -u www cmd`) can be mistaken for the program.

const MAX_SEGMENTS = 20;
const MAX_SEGMENT_CHARS = 200;
const MAX_PROGRAMS = 30;
const MAX_PROGRAM_CHARS = 60;

// Control-flow words that are never the program. `for`/`case` abort the whole
// stage (the words after them are variables/subjects, not commands).
const KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done',
  'for', 'in', 'case', 'esac', 'select', 'function', 'coproc',
  '{', '}', '!', '[[', ']]', '[',
]);

// Wrappers whose real program is a later word.
const WRAPPERS = new Set([
  'sudo', 'env', 'time', 'nohup', 'nice', 'command', 'stdbuf', 'timeout',
  'setsid', 'xargs',
]);

// Known multi-word tools: how many subcommand words to keep after the program.
const SUBCMD = {
  git: 1, gh: 2, npm: 1, npx: 1, yarn: 1, pnpm: 1, pip: 1, pip3: 1,
  docker: 1, 'docker-compose': 1, kubectl: 1, helm: 1, terraform: 1,
  cargo: 1, go: 1, gem: 1, bundle: 1, composer: 1,
  apt: 1, 'apt-get': 1, dnf: 1, brew: 1, systemctl: 1,
  gcloud: 2, aws: 2, claude: 1, graphify: 1,
};

// Index of the `close` matching an already-open `open` (quote-aware), or
// str.length when unbalanced.
function matchDelim(str, start, open, close) {
  let depth = 1;
  let inS = false;
  let inD = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\' && !inS) { i++; continue; }
    if (inS) { if (ch === "'") inS = false; continue; }
    if (ch === "'" && !inD) { inS = true; continue; }
    if (ch === '"') { inD = !inD; continue; }
    if (inD) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return str.length;
}

// One pass over str at nesting depth 0: where the top-level cuts are (segment
// separators and pipes), and the contents of any substitution/subshell spans
// (skipped over for cutting, collected for program recursion).
function scanTop(str) {
  const cuts = []; // {i, len, pipe}
  const subs = [];
  let inS = false;
  let inD = false;
  let i = 0;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (ch === '\\' && !inS) { i += 2; continue; }
    if (inS) { if (ch === "'") inS = false; i++; continue; }
    if (ch === "'" && !inD) { inS = true; i++; continue; }
    if (ch === '"') { inD = !inD; i++; continue; }
    if (ch === '`') {
      let j = i + 1;
      while (j < n && str[j] !== '`') j += str[j] === '\\' ? 2 : 1;
      subs.push(str.slice(i + 1, Math.min(j, n)));
      i = Math.min(j, n) + 1;
      continue;
    }
    if (ch === '$' && str[i + 1] === '(') {
      const end = matchDelim(str, i + 2, '(', ')');
      subs.push(str.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (ch === '$' && str[i + 1] === '{') {
      i = matchDelim(str, i + 2, '{', '}') + 1; // opaque parameter expansion
      continue;
    }
    if (inD) { i++; continue; }
    if ((ch === '<' || ch === '>') && str[i + 1] === '(') { // process substitution
      const end = matchDelim(str, i + 2, '(', ')');
      subs.push(str.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (ch === '(') { // subshell: one segment, recursed for programs
      const end = matchDelim(str, i + 1, '(', ')');
      subs.push(str.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      // Heredoc: from the next newline on it's document body, not commands.
      let j = str.indexOf('\n', i);
      if (j === -1) j = n;
      cuts.push({ i: j, len: n - j, pipe: false });
      break;
    }
    if (ch === '>' || ch === '<') { i += str[i + 1] === '&' ? 2 : 1; continue; }
    if (ch === '&' && str[i + 1] === '>') { i += 2; continue; }
    if (ch === '&' && str[i + 1] === '&') { cuts.push({ i, len: 2, pipe: false }); i += 2; continue; }
    if (ch === '|' && str[i + 1] === '|') { cuts.push({ i, len: 2, pipe: false }); i += 2; continue; }
    if (ch === ';') {
      const len = str[i + 1] === ';' ? 2 : 1;
      cuts.push({ i, len, pipe: false });
      i += len;
      continue;
    }
    if (ch === '\n' || ch === '&') { cuts.push({ i, len: 1, pipe: false }); i++; continue; }
    if (ch === '|') {
      const len = str[i + 1] === '&' ? 2 : 1;
      cuts.push({ i, len, pipe: true });
      i += len;
      continue;
    }
    i++;
  }
  return { cuts, subs };
}

function cutPieces(str, cuts, atPipes) {
  const pieces = [];
  let start = 0;
  for (const c of cuts) {
    if (c.pipe && !atPipes) continue;
    pieces.push(str.slice(start, c.i));
    start = c.i + c.len;
  }
  pieces.push(str.slice(start));
  return pieces.map((s) => s.trim()).filter(Boolean);
}

// Whitespace word split that keeps quoted strings and (sub)shell spans whole,
// so `f=$(find . | head -1)` is one word.
function words(stage) {
  const out = [];
  let cur = '';
  let inS = false;
  let inD = false;
  let par = 0;
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i];
    if (ch === '\\' && !inS) { cur += ch + (stage[i + 1] || ''); i++; continue; }
    if (inS) { cur += ch; if (ch === "'") inS = false; continue; }
    if (ch === "'" && !inD) { inS = true; cur += ch; continue; }
    if (ch === '"') { inD = !inD; cur += ch; continue; }
    if (!inD) {
      if (ch === '(') par++;
      else if (ch === ')' && par > 0) par--;
      if (par === 0 && /\s/.test(ch)) {
        if (cur) { out.push(cur); cur = ''; }
        continue;
      }
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// The program (+known subcommand) of one pipeline stage, '' when there is
// none worth counting (pure assignment, control keyword, variable command).
function extractProgram(stage) {
  const ws = words(stage);
  let prog = '';
  let i = 0;
  let wrapped = false;
  for (; i < ws.length; i++) {
    let w = ws[i];
    if (/^[0-9]*(<|>|>>|<<<?)$/.test(w)) { i++; continue; } // bare redirect + its target
    if (/^[0-9]*[<>]/.test(w)) continue; // >file, 2>&1, <in
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // env/var assignment
    if (KEYWORDS.has(w)) {
      if (w === 'for' || w === 'case') return '';
      continue;
    }
    if (WRAPPERS.has(w)) { wrapped = true; continue; }
    if (w.startsWith('-')) continue; // wrapper flags (sudo -u, nice -n)
    if (wrapped && /^[0-9]+[a-z]*$/i.test(w)) continue; // timeout 5, nice 10
    w = w.replace(/^['"]|['"]$/g, '');
    if (!w || w[0] === '$' || w[0] === '<' || w[0] === '(') return '';
    prog = w.replace(/^\.\//, '');
    i++;
    break;
  }
  if (!prog) return '';
  const depth = Object.prototype.hasOwnProperty.call(SUBCMD, prog) ? SUBCMD[prog] : 0;
  let taken = 0;
  for (; i < ws.length && taken < depth; i++) {
    const w = ws[i];
    if (w.startsWith('-')) continue; // git --no-pager log
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(w)) break;
    prog += ` ${w}`;
    taken++;
  }
  return prog;
}

function collectPrograms(str, out, depth) {
  const { cuts, subs } = scanTop(str);
  for (const stage of cutPieces(str, cuts, true)) {
    const p = extractProgram(stage);
    if (p) out.push(p);
  }
  if (depth > 0) for (const sub of subs) collectPrograms(sub, out, depth - 1);
}

function splitCommand(cmd) {
  const str = String(cmd || '');
  const { cuts } = scanTop(str);
  const segments = cutPieces(str, cuts, false)
    .slice(0, MAX_SEGMENTS)
    .map((s) => s.slice(0, MAX_SEGMENT_CHARS));
  const programs = [];
  collectPrograms(str, programs, 1);
  return {
    segments,
    programs: programs.slice(0, MAX_PROGRAMS).map((p) => p.slice(0, MAX_PROGRAM_CHARS)),
  };
}

module.exports = { splitCommand };
