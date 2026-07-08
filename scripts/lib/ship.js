'use strict';
// Elasticsearch shipper. Run as a detached CLI by common.js's shipEvent()
// (node ship.js '<json-line>'), and require()d by session-summary.js for the
// foreground SessionEnd ship. Deterministic _id (sha1 of the line) makes
// retries and the backfill idempotent server-side.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { envc, shipConfigFile, shipSpoolFile } = require('./common.js');

// config.env is a shell-style KEY="value" file (same format the bash hooks
// used); parsed without executing anything.
function parseEnvFile(file) {
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

// null when shipping is disabled/unconfigured. File values override process
// env (matching the bash version, which sourced the file last); UK2_/CHIMERA_
// aliasing applies to both.
function loadShipConfig() {
  let fileVars;
  try { fileVars = parseEnvFile(shipConfigFile()); } catch { return null; }
  const src = { ...process.env, ...fileVars };
  if (envc('TELEMETRY_DISABLE', src)) return null;
  const url = envc('TELEMETRY_ES_URL', src);
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ''),
    index: envc('TELEMETRY_ES_INDEX', src) || 'claude-telemetry',
    apiKey: envc('TELEMETRY_ES_API_KEY', src),
    cfId: envc('TELEMETRY_CF_CLIENT_ID', src),
    cfSecret: envc('TELEMETRY_CF_CLIENT_SECRET', src),
  };
}

function headers(cfg, contentType) {
  const h = { 'Content-Type': contentType };
  if (cfg.apiKey) h.Authorization = `ApiKey ${cfg.apiKey}`;
  if (cfg.cfId) {
    h['CF-Access-Client-Id'] = cfg.cfId;
    h['CF-Access-Client-Secret'] = cfg.cfSecret;
  }
  return h;
}

async function shipOne(cfg, line) {
  const id = crypto.createHash('sha1').update(line).digest('hex');
  try {
    const res = await fetch(`${cfg.url}/${cfg.index}/_doc/${id}`, {
      method: 'POST',
      headers: headers(cfg, 'application/json'),
      body: line,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}

function spoolLine(line) {
  try {
    const spool = shipSpoolFile();
    fs.mkdirSync(path.dirname(spool), { recursive: true });
    fs.appendFileSync(spool, `${line}\n`);
  } catch { /* fail open */ }
}

// Re-ship previously failed events. Lock file keeps this to one flusher at a
// time (a lock older than 60s is treated as a crash leftover and removed);
// lines past the cap, or that fail again, are kept for the next flush.
async function flushSpool(cfg, max = 200) {
  const spool = shipSpoolFile();
  try { if (!fs.statSync(spool).size) return; } catch { return; }
  const lock = `${spool}.lock`;
  try {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmSync(lock, { force: true });
    } catch { /* no lock */ }
    fs.closeSync(fs.openSync(lock, 'wx'));
  } catch { return; } // another flusher is active
  try {
    const tmp = `${spool}.flush`;
    try { fs.renameSync(spool, tmp); } catch { return; }
    const lines = fs.readFileSync(tmp, 'utf8').split('\n').filter(Boolean);
    let n = 0;
    for (const line of lines) {
      n += 1;
      if (n > max || !(await shipOne(cfg, line))) fs.appendFileSync(spool, `${line}\n`);
    }
    fs.rmSync(tmp, { force: true });
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

if (require.main === module) {
  (async () => {
    try {
      const line = process.argv[2];
      if (!line) return;
      const cfg = loadShipConfig();
      if (!cfg) return;
      if (!(await shipOne(cfg, line))) spoolLine(line);
      await flushSpool(cfg, 50);
    } catch { /* fail open */ }
  })().finally(() => process.exit(0));
}

module.exports = { parseEnvFile, loadShipConfig, shipOne, spoolLine, flushSpool };
