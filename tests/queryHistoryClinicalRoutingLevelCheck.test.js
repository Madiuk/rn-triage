// tests/queryHistoryClinicalRoutingLevelCheck.test.js
//
// CONTRACT TEST — migration 0014 must declare a CHECK constraint on
// query_history.clinical_routing_level whose allowlist is set-equal
// to the canonical enum in normalizeTriageOutput (data/triage-lib.js).
//
// Style follows queryHistoryUrgencyOriginalCheck.test.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0014_query_history_clinical_routing_level_check.sql';
const LIB_REL       = 'data/triage-lib.js';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
}
function readLib() {
  return fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
}

function extractMigrationAllowlist(sql) {
  const idx = sql.toLowerCase().indexOf('add constraint query_history_clinical_routing_level_check');
  if (idx === -1) {
    throw new Error(
      'ADD CONSTRAINT query_history_clinical_routing_level_check not found in ' + MIGRATION_REL
    );
  }
  const tail = sql.slice(idx);
  const semi = tail.indexOf(';');
  if (semi === -1) throw new Error('ADD CONSTRAINT statement is not semicolon-terminated.');
  const stmt = tail.slice(0, semi + 1);
  const m = stmt.match(/in\s*\(([^)]+)\)/i);
  if (!m) throw new Error('CHECK clause has no IN-list:\n' + stmt);
  const items = [];
  const re = /'([^']+)'/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) items.push(mm[1]);
  if (items.length === 0) throw new Error('CHECK IN-list contains no string literals.');
  return items;
}

// Pull the canonical enum from normalizeTriageOutput. Anchor:
//   out.clinical_routing_level = normalizeEnum(out.clinical_routing_level, [
//     'severe', 'moderate', 'mild', 'none',
//   ]) || 'none';
function extractLibAllowlist(src) {
  const anchor = 'out.clinical_routing_level = normalizeEnum(out.clinical_routing_level, [';
  const idx = src.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'Anchor `' + anchor + '` not found in ' + LIB_REL +
      ' — has normalizeTriageOutput been restructured?'
    );
  }
  const tail = src.slice(idx + anchor.length);
  const close = tail.indexOf(']');
  if (close === -1) throw new Error('routing-level enum literal has no closing bracket.');
  const inner = tail.slice(0, close);
  const items = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(inner)) !== null) items.push(m[1]);
  if (items.length === 0) throw new Error('routing-level enum literal contains no strings.');
  return items;
}

describe('CONTRACT: query_history.clinical_routing_level CHECK constraint (migration 0014)', () => {
  it('migration file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, MIGRATION_REL)),
      MIGRATION_REL + ' is missing.'
    );
  });

  it('declares a named CHECK constraint on public.query_history', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/add constraint query_history_clinical_routing_level_check/.test(sql));
    assert.ok(/alter table public\.query_history/.test(sql));
  });

  it('allows NULL', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /clinical_routing_level\s+is\s+null/.test(sql),
      'CHECK must explicitly accept NULL.'
    );
  });

  it('accepts each value in normalizeTriageOutput\'s routing-level enum (positive)', () => {
    const migration = extractMigrationAllowlist(readMigration());
    const lib       = extractLibAllowlist(readLib());
    for (const v of lib) {
      assert.ok(
        migration.includes(v),
        'enum value "' + v + '" missing from migration CHECK. Migration: ' + JSON.stringify(migration)
      );
    }
  });

  it('rejects any value the AI normalization layer doesn\'t produce (negative)', () => {
    const migration = extractMigrationAllowlist(readMigration());
    const lib       = extractLibAllowlist(readLib());
    for (const v of migration) {
      assert.ok(
        lib.includes(v),
        'migration CHECK accepts "' + v + '" but normalizeTriageOutput does not produce it. Lib: ' + JSON.stringify(lib)
      );
    }
  });

  it('migration allowlist is set-equal to normalizeTriageOutput\'s routing-level enum', () => {
    const migration = new Set(extractMigrationAllowlist(readMigration()));
    const lib       = new Set(extractLibAllowlist(readLib()));
    assert.deepEqual(
      Array.from(migration).sort(),
      Array.from(lib).sort(),
      'DB CHECK allowlist must be byte-identical to the routing-level enum.'
    );
  });

  it('has a defensive backfill UPDATE before the CHECK is added', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/update\s+public\.query_history/.test(sql));
    assert.ok(/set\s+clinical_routing_level\s*=\s*null/.test(sql));
    const updateIdx = sql.indexOf('update public.query_history');
    const addIdx    = sql.indexOf('add constraint query_history_clinical_routing_level_check');
    assert.ok(updateIdx >= 0 && addIdx >= 0 && updateIdx < addIdx,
      'UPDATE must appear before ADD CONSTRAINT.');
  });

  it('is idempotent — wraps add in a DROP CONSTRAINT IF EXISTS / ADD pair', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/drop\s+constraint\s+if\s+exists\s+query_history_clinical_routing_level_check/.test(sql));
  });
});
