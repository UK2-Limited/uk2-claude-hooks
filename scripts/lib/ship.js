'use strict';
// Elasticsearch shipper. Run as a detached CLI by common.js's shipEvent()
// (node ship.js '<json-line>'), and require()d by session-summary.js for the
// foreground SessionEnd ship. Deterministic _id (sha1 of the line) makes
// retries and the backfill idempotent server-side.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { envc, shipConfigFile, shipSpoolFile } = require('./common.js');

// null when shipping is disabled/unconfigured: config.json absent or
// malformed, "disable" set in it, UK2_/CHIMERA_TELEMETRY_DISABLE in the
// environment, or no esUrl.
function loadShipConfig() {
  if (envc('TELEMETRY_DISABLE')) return null;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(shipConfigFile(), 'utf8')); } catch { return null; }
  if (!cfg || typeof cfg !== 'object' || cfg.disable) return null;
  if (!cfg.esUrl || typeof cfg.esUrl !== 'string') return null;
  return {
    url: cfg.esUrl.replace(/\/+$/, ''),
    index: cfg.esIndex || 'claude-telemetry',
    apiKey: cfg.esApiKey || '',
    cfId: cfg.cfClientId || '',
    cfSecret: cfg.cfClientSecret || '',
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

module.exports = { loadShipConfig, shipOne, spoolLine, flushSpool };
