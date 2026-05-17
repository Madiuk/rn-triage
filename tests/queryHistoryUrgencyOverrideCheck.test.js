// tests/queryHistoryUrgencyOverrideCheck.test.js
//
// CONTRACT TEST — migration 0025_query_history_urgency_override_drop_24h.sql
// must declare a CHECK constraint on public.query_history.urgency_override
// whose allowlist is set-equal to URGENCY_OVERRIDE_VALUES in
// netlify/functions/_lib/routes/history.js.
//
// 0025 supersedes 0012's allowlist (it narrows the set from five values
// to three by dropping the legacy "24h" and "24-72h" refinements that
// were never wired into the new tasking SPA UI). The constraint name is
// the same — 0025 drops 0012's constraint and re-adds the narrower one
// — so the latest migration is the authoritative source for parity.
//
// Why DB ↔ code parity matters:
//   - If the DB allowlist is a superset, the route validation rejects
//     values the DB would accept — staff get spurious 400s with no
//     audit trail of why.
//   - If the DB allowlist is a subset, the route accepts values the DB
//     will then reject — staff get inscrutable 5xx errors when their
//     legitimate-looking value hits the constraint.
//   - Either drift is invisible until a user hits it. This test makes
//     a drift visible at CI time instead.
//
// Style follows clinicalDetection.test.js (which enforces server-vs-
// client agreement on classification logic) and the previous task's
// queryHistoryRlsPolicy.test.js (which enforces the deny-policy shape
// against a migration source file).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0025_query_history_urgency_override_drop_24h.sql';
const ROUTE_REL    = 'netlify/functions/_lib/routes/history.js';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
}
function readRoute() {
  return fs.readFileSync(path.join(ROOT, ROUTE_REL), 'utf8');
}

// Extract the allowlist literal from the CHECK constraint in the
// migration. Anchors on the constraint name so a rename surfaces as a
// clear failure rather than as a confusing parity diff.
function extractMigrationAllowlist(sql) {
  const idx = sql.toLowerCase().indexOf('add constraint query_history_urgency_override_check');
  if (idx === -1) {
    throw new Error(
      'ADD CONSTRAINT query_history_urgency_override_check not found in ' + MIGRATION_REL
    );
  }
  // Take from there to the next semicolon — covers the entire ADD
  // CONSTRAINT statement including the CHECK clause.
  const tail = sql.slice(idx);
  const semi = tail.indexOf(';');
  if (semi === -1) throw new Error('ADD CONSTRAINT statement is not semicolon-terminated.');
  const stmt = tail.slice(0, semi + 1);

  // Pull the IN-list. There is exactly one in the CHECK statement.
  const m = stmt.match(/in\s*\(([^)]+)\)/i);
  if (!m) throw new Error('CHECK clause has no IN-list:\n' + stmt);

  // Each element is a single-quoted string; collect the literals.
  const items = [];
  const re = /'([^']+)'/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) items.push(mm[1]);
  if (items.length === 0) throw new Error('CHECK IN-list contains no string literals.');
  return items;
}

// Extract the URGENCY_OVERRIDE_VALUES set from the route module
// source. The literal `new Set([...])` lives on a single block in
// history.js. We parse the string literals out of that block to keep
// the test resilient to whitespace/formatting changes.
function extractRouteAllowlist(src) {
  const idx = src.indexOf('URGENCY_OVERRIDE_VALUES');
  if (idx === -1) throw new Error('URGENCY_OVERRIDE_VALUES not found in ' + ROUTE_REL);
  // Find the `new Set([` after the identifier, then the matching `])`.
  const tail = src.slice(idx);
  const startBracket = tail.indexOf('new Set([');
  if (startBracket === -1) {
    throw new Error('URGENCY_OVERRIDE_VALUES is not declared as `new Set([...])`.');
  }
  const close = tail.indexOf('])', startBracket);
  if (close === -1) throw new Error('URGENCY_OVERRIDE_VALUES is missing its closing `])`.');
  const inner = tail.slice(startBracket + 'new Set(['.length, close);

  const items = [];
  // Tolerate either single OR double quotes — history.js uses double.
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(inner)) !== null) items.push(m[1]);
  if (items.length === 0) throw new Error('URGENCY_OVERRIDE_VALUES contains no string literals.');
  return items;
}

describe('CONTRACT: query_history.urgency_override CHECK constraint (migration 0025)', () => {
  it('migration file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, MIGRATION_REL)),
      MIGRATION_REL + ' is missing.'
    );
  });

  it('declares a named CHECK constraint on public.query_history', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /add constraint query_history_urgency_override_check/.test(sql),
      'expected ADD CONSTRAINT query_history_urgency_override_check; got: ' + sql.slice(0, 200)
    );
    assert.ok(
      /alter table public\.query_history/.test(sql),
      'constraint must be added to public.query_history.'
    );
  });

  it('allows NULL — staff "no override applied" is the default state', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /urgency_override\s+is\s+null/.test(sql),
      'CHECK must explicitly accept NULL (the "no override" state); got: ' + sql.slice(0, 400)
    );
  });

  it('accepts each value in URGENCY_OVERRIDE_VALUES (positive control)', () => {
    const migration = extractMigrationAllowlist(readMigration());
    const route     = extractRouteAllowlist(readRoute());
    for (const v of route) {
      assert.ok(
        migration.includes(v),
        'route allowlist value "' + v + '" missing from migration CHECK. ' +
        'Code would accept it; DB would reject it. Migration list: ' + JSON.stringify(migration)
      );
    }
  });

  it('rejects any value NOT in URGENCY_OVERRIDE_VALUES (negative control)', () => {
    const migration = extractMigrationAllowlist(readMigration());
    const route     = extractRouteAllowlist(readRoute());
    for (const v of migration) {
      assert.ok(
        route.includes(v),
        'migration CHECK accepts "' + v + '" but route does not validate it. ' +
        'DB would accept; route never produces it. Route allowlist: ' + JSON.stringify(route)
      );
    }
  });

  it('migration allowlist is set-equal to URGENCY_OVERRIDE_VALUES', () => {
    const migration = new Set(extractMigrationAllowlist(readMigration()));
    const route     = new Set(extractRouteAllowlist(readRoute()));
    assert.deepEqual(
      Array.from(migration).sort(),
      Array.from(route).sort(),
      'DB CHECK allowlist must be byte-identical to URGENCY_OVERRIDE_VALUES.'
    );
  });

  it('has a defensive backfill UPDATE before the CHECK is added', () => {
    // Precedent from 0004_query_history_state.sql: clear non-conforming
    // values before the constraint lands. Without this, the ADD
    // CONSTRAINT step would fail outright on any pre-existing dirty
    // row, blocking the entire migration.
    const sql = readMigration().toLowerCase();
    assert.ok(
      /update\s+public\.query_history/.test(sql),
      'migration must include an UPDATE that backfills dirty rows before the CHECK is added.'
    );
    assert.ok(
      /set\s+urgency_override\s*=\s*null/.test(sql),
      'backfill UPDATE must clear urgency_override to NULL (not to a hard-coded value).'
    );
    // The backfill UPDATE must appear BEFORE the ADD CONSTRAINT, not
    // after — otherwise the constraint add would fail first.
    const updateIdx = sql.indexOf('update public.query_history');
    const addIdx    = sql.indexOf('add constraint query_history_urgency_override_check');
    assert.ok(
      updateIdx >= 0 && addIdx >= 0 && updateIdx < addIdx,
      'backfill UPDATE must appear before the ADD CONSTRAINT statement.'
    );
  });

  it('is idempotent — wraps add in a DROP CONSTRAINT IF EXISTS / ADD pair', () => {
    // Re-running a migration must be a no-op per migrations/README.md.
    const sql = readMigration().toLowerCase();
    assert.ok(
      /drop\s+constraint\s+if\s+exists\s+query_history_urgency_override_check/.test(sql),
      'migration must DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT so re-runs are no-ops.'
    );
  });
});
