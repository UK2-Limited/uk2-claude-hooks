#!/usr/bin/env node
'use strict';
// One-off CLI (not a hook): bulk-import the telemetry JSONL accumulated under
// <project>/.claude/telemetry/ into Elasticsearch. Idempotent — each doc's
// _id is the sha1 of its JSON line, the same scheme the live shipper uses, so
// re-runs (and the session_summary line that exists in both the session file
// and summaries.jsonl) dedupe server-side.
//
//   node telemetry-backfill.js [project-root]     (default: cwd)
//
// Reads the same config as the live shipper (<project>/.claude/telemetry/
// config.json or $UK2_TELEMETRY_CONFIG / $CHIMERA_TELEMETRY_CONFIG).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Point the shared helpers at the target project before loading them.
process.env.CLAUDE_PROJECT_DIR = path.resolve(process.argv[2] || process.cwd());

const c = require('./lib/common.js');
const ship = require('./lib/ship.js');

const BATCH = 500;

async function main() {
  const cfg = ship.loadShipConfig();
  if (!cfg) {
    console.error(`no usable config at ${c.shipConfigFile()} — copy telemetry.json.example there `
      + 'and set esUrl first');
    process.exit(1);
  }

  const teleDir = path.join(c.repoRoot(), '.claude', 'telemetry');
  const files = [];
  try {
    for (const f of fs.readdirSync(path.join(teleDir, 'sessions'))) {
      if (f.endsWith('.jsonl')) files.push(path.join(teleDir, 'sessions', f));
    }
  } catch { /* no sessions dir */ }
  if (fs.existsSync(path.join(teleDir, 'summaries.jsonl'))) {
    files.push(path.join(teleDir, 'summaries.jsonl'));
  }

  let sent = 0;
  let skipped = 0;
  let body = '';

  async function flush() {
    if (!body) return;
    let res;
    try {
      res = await fetch(`${cfg.url}/_bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          ...(cfg.apiKey ? { Authorization: `ApiKey ${cfg.apiKey}` } : {}),
          ...(cfg.cfId ? { 'CF-Access-Client-Id': cfg.cfId, 'CF-Access-Client-Secret': cfg.cfSecret } : {}),
        },
        body,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      console.error(`bulk request failed: ${e.message}`);
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`bulk request failed: HTTP ${res.status}`);
      process.exit(1);
    }
    try {
      const parsed = await res.json();
      if (parsed.errors) {
        const errs = (parsed.items || []).filter((i) => i.index && i.index.error).slice(0, 3);
        console.error('some items were rejected (first 3 errors):');
        console.error(JSON.stringify(errs, null, 2));
      }
    } catch { /* non-JSON response — sent anyway */ }
    body = '';
  }

  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { JSON.parse(line); } catch { skipped += 1; continue; }
      const id = crypto.createHash('sha1').update(line).digest('hex');
      body += `${JSON.stringify({ index: { _index: cfg.index, _id: id } })}\n${line}\n`;
      sent += 1;
      if (sent % BATCH === 0) await flush();
    }
  }
  await flush();
  console.log(`backfilled ${sent} events into ${cfg.index} (skipped ${skipped} corrupt lines)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
