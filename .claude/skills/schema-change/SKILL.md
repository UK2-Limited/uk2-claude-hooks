---
name: schema-change
description: Safely change the telemetry event schema (add/rename/remove event fields shipped to Elasticsearch). Use whenever a change touches logEvent() payloads, the event envelope in common.js, ship IDs, or the README schema table.
---

# Telemetry schema changes

The schema table in `README.md` is a **contract**: Grafana dashboards and the
Elasticsearch index consume these events. Treat it like a public API.

## Rules

- **Additive fields are fine.** Add the field in the emitting hook (or the envelope in
  `scripts/lib/common.js`), add it to the README schema table, and add a test asserting
  it appears in the logged JSONL — all in the same commit.
- **Renames and removals need a deliberate decision.** Do not do them as a side effect
  of a refactor. Stop and confirm with the user; the Grafana dashboards must be updated
  in lockstep.
- **Never touch the ship-ID scheme.** Elasticsearch `_id` = sha1 of the raw JSON line,
  shared by the live shipper (`scripts/lib/ship.js`) and `scripts/telemetry-backfill.js`.
  Changing how the line is serialized (key order, whitespace, field defaults) changes
  the sha1 and breaks idempotent retries/dedupe. If a change alters the serialized line
  of *existing* event types, flag it explicitly.
- **Keep bash-suite compatibility.** The Chimera bash+jq suite is the behavioral
  reference: same event schema, same `UK2_*`/`CHIMERA_*` env fallback (via
  `common.envc()` only), same file locations under the consuming project's `.claude/`.

## Where events are shaped

- Envelope + common fields: `logEvent()` in `scripts/lib/common.js`
- Per-call events: `scripts/telemetry-posttool.js`
- Session roll-up: `scripts/session-summary.js`
- Send/spool/flush + `_id`: `scripts/lib/ship.js`

## Checklist

1. Change the emitter (additive) or get sign-off (rename/removal).
2. Update the README schema table in the same commit.
3. Add/extend a test in `test/run.js` asserting the new field in the local JSONL.
4. Run `/verify`.
