#!/usr/bin/env node
'use strict';
// One-off CLI (not a hook): recover slash-invoked skills (typed `/skill args`)
// from past transcripts as `skill_use` events. Live sessions record these at
// SessionEnd (session-summary.js); this replays the same extraction
// (common.slashSkillInvocations / slashSkillFields) over sessions that ended
// before that existed.
//
//   node slash-skill-backfill.js [project-root] [--projects-dir <dir>] [--dry-run]
//
// project-root (default: cwd) is the repo the sessions ran in: its
// .claude/telemetry/ receives the lines and its config.json says where to ship.
// --projects-dir is that project's transcript directory (default:
// ~/.claude/projects/<flattened project-root>/). Only its top-level *.jsonl are
// read — slash commands never appear in sub-agent transcripts.
//
// Each new line is appended to its session's own JSONL, as the live path would
// have done, and shipped with the live shipper's sha1 _id; a failed ship goes
// to the spool for the next hook to flush. Invocations already logged anywhere
// in the project's telemetry are skipped, so a re-run adds nothing, and a later
// SessionEnd of a backfilled session will not log them again either.
//
// --dry-run writes and ships nothing: it prints every line it would emit, with
// its _id.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const USAGE = 'usage: slash-skill-backfill.js [project-root] [--projects-dir <dir>] [--dry-run]';

// Parse argv before loading common.js — the positional root must land in
// CLAUDE_PROJECT_DIR so the shared path helpers point at the target project.
const opts = { root: '', projectsDir: '', dryRun: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--projects-dir') opts.projectsDir = argv[(i += 1)] || '';
    else if (!a.startsWith('--') && !opts.root) opts.root = a;
    else {
      process.stderr.write(`unknown argument: ${a}\n${USAGE}\n`);
      process.exit(2);
    }
  }
}
process.env.CLAUDE_PROJECT_DIR = path.resolve(opts.root || process.cwd());

const c = require('./lib/common.js');
const ship = require('./lib/ship.js');

const ROOT = c.repoRoot();
// Claude Code flattens the project path into one directory name (same rule
// telemetry-verify.js uses).
const TDIR = path.resolve(opts.projectsDir
  || path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[/._]/g, '-')));

// The issue a session was working on, from its own telemetry (last non-null
// value). currentIssue() would stamp every past session with today's ticket.
function sessionIssue(sid) {
  let issue = null;
  try {
    const file = path.join(ROOT, '.claude', 'telemetry', 'sessions', `${sid}.jsonl`);
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.includes('"issue":')) continue;
      try {
        const ev = JSON.parse(l);
        if (ev.issue) issue = ev.issue;
      } catch { /* corrupt line */ }
    }
  } catch { /* no telemetry for this session */ }
  return issue;
}

const sha1 = (line) => crypto.createHash('sha1').update(line).digest('hex');
const short = (s) => String(s).slice(0, 8);
const label = (inv) => {
  const cmd = `/${inv.skill}${inv.args === null ? '' : ` ${inv.args}`}`.replace(/\s+/g, ' ');
  return cmd.length > 90 ? `${cmd.slice(0, 89)}…` : cmd;
};

async function main() {
  let files;
  try {
    files = fs.readdirSync(TDIR).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    process.stderr.write(`no transcript directory at ${TDIR} — pass --projects-dir <dir>\n${USAGE}\n`);
    process.exit(2);
  }

  const cfg = ship.loadShipConfig();
  const logged = c.loggedSlashSkillUuids(0);
  const emittedBy = new Map(); // transcript_uuid -> session that emits it in this run
  const todo = [];
  const skipped = [];

  for (const f of files) {
    const sid = f.slice(0, -'.jsonl'.length);
    const invs = c.slashSkillInvocations(c.transcriptTail(path.join(TDIR, f), Infinity));
    if (!invs.length) continue;
    const issue = sessionIssue(sid);
    for (const inv of invs) {
      if (logged.has(inv.transcript_uuid)) {
        skipped.push({ sid, inv, why: 'already logged' });
      } else if (emittedBy.has(inv.transcript_uuid)) {
        // A forked/background session copies its parent's history, uuids and all.
        skipped.push({ sid, inv, why: `copy of the entry in session ${short(emittedBy.get(inv.transcript_uuid))}` });
      } else {
        emittedBy.set(inv.transcript_uuid, sid);
        todo.push({ sid, inv, extra: { ...c.slashSkillFields(inv), issue } });
      }
    }
  }
  todo.sort((a, b) => a.inv.ts.localeCompare(b.inv.ts) || a.sid.localeCompare(b.sid));

  let target = `shipping not configured (no usable ${c.shipConfigFile()}) — would record locally only`;
  if (cfg) {
    let host = cfg.url;
    try { host = new URL(cfg.url).host; } catch { /* print as configured */ }
    target = `${host} index ${cfg.index}`;
  }
  console.log(`slash-skill backfill${opts.dryRun ? ' — DRY RUN: nothing written, nothing shipped' : ''}`);
  console.log(`project:     ${ROOT}`);
  console.log(`transcripts: ${TDIR} (${files.length} files)`);
  console.log(`target:      ${target}`);
  console.log('');
  console.log(`${opts.dryRun ? 'would emit' : 'emitting'} ${todo.length} skill_use event(s):`);
  for (const t of todo) console.log(`  ${t.inv.ts}  ${short(t.sid)}  ${label(t.inv)}`);
  if (skipped.length) {
    console.log(`skipped ${skipped.length}:`);
    for (const s of skipped) {
      console.log(`  ${s.inv.ts}  ${short(s.sid)}  ${label(s.inv)}  [${short(s.inv.transcript_uuid)}: ${s.why}]`);
    }
  }

  if (opts.dryRun) {
    console.log('');
    console.log('lines (<_id> <json line>):');
    for (const t of todo) {
      const line = c.eventLine({ session_id: t.sid }, 'skill_use', t.extra);
      console.log(`${sha1(line)} ${line}`);
    }
    return;
  }

  let recorded = 0;
  let shipped = 0;
  let spooled = 0;
  let failed = 0;
  let reachable = Boolean(cfg);
  for (const t of todo) {
    const line = c.logEvent({ session_id: t.sid }, 'skill_use', t.extra, { ship: false });
    if (!line) { failed += 1; continue; }
    recorded += 1;
    if (!cfg) continue;
    // After one failure, spool the rest without trying (each try can cost a
    // full fetch timeout); the next hook run flushes the spool.
    if (reachable) reachable = await ship.shipOne(cfg, line);
    if (reachable) shipped += 1;
    else { ship.spoolLine(line); spooled += 1; }
  }
  console.log('');
  console.log(`recorded ${recorded} in ${path.join(ROOT, '.claude', 'telemetry', 'sessions')}`
    + (cfg ? `; shipped ${shipped}, spooled ${spooled} for retry` : '; shipping not configured')
    + (failed ? `; FAILED to record ${failed}` : ''));
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
