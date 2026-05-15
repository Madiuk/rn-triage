// tests/queryHistoryClinicalCategoryCheck.test.js
//
// CONTRACT TEST — migration 0018 must declare a CHECK constraint on
// query_history.clinical_category whose allowlist is set-equal to the
// canonicalCategories array in normalizeTriageOutput
// (data/triage-lib.js). If either side drifts, this test fails
// before the drift can reach production aggregations / pill UI / KB
// promotion.
//
// Style follows tests/queryHistoryClinicalRoutingLevelCheck.test.js
// (the migration 0014 companion).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0018_query_history_clinical_category_check.sql';
const LIB_REL       = 'data/triage-lib.js';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
}
function readLib() {
  return fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
}

// Pull the IN-list from the ADD CONSTRAINT statement. The migration
// uses the allowlist in two places (backfill UPDATE and ADD CHECK);
// we read the CHECK one so the test fails on drift in the binding
// allowlist, not the defensive backfill one (which we DO assert is
// identical, separately).
function extractMigrationAllowlist(sql, anchor) {
  const idx = sql.toLowerCase().indexOf(anchor.toLowerCase());
  if (idx === -1) {
    throw new Error(anchor + ' not found in ' + MIGRATION_REL);
  }
  const tail = sql.slice(idx);
  const semi = tail.indexOf(';');
  if (semi === -1) throw new Error('Statement is not semicolon-terminated.');
  const stmt = tail.slice(0, semi + 1);
  const m = stmt.match(/in\s*\(([^)]+)\)/i);
  if (!m) throw new Error('Statement has no IN-list:\n' + stmt);
  const items = [];
  const re = /'([^']+)'/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) items.push(mm[1]);
  if (items.length === 0) throw new Error('IN-list contains no string literals.');
  return items;
}

// Pull the canonicalCategories enum from normalizeTriageOutput.
// Anchor: the literal array declaration in data/triage-lib.js. The
// trailing single-line comment "// 6-value enum (case-sensitive)" is
// stable; the var-name "canonicalCategories" is what we search for.
function extractLibAllowlist(src) {
  const anchor = 'var canonicalCategories = [';
  const idx = src.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'Anchor `' + anchor + '` not found in ' + LIB_REL +
      ' — has normalizeTriageOutput been restructured?'
    );
  }
  const tail = src.slice(idx + anchor.length);
  const close = tail.indexOf(']');
  if (close === -1) throw new Error('canonicalCategories literal has no closing bracket.');
  const inner = tail.slice(0, close);
  const items = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(inner)) !== null) items.push(m[1]);
  if (items.length === 0) throw new Error('canonicalCategories literal contains no strings.');
  return items;
}

describe('CONTRACT: query_history.clinical_category CHECK constraint (migration 0018)', () => {
  it('migration file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, MIGRATION_REL)),
      MIGRATION_REL + ' is missing.'
    );
  });

  it('declares a named CHECK constraint on public.query_history', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/add constraint query_history_clinical_category_check/.test(sql));
    assert.ok(/alter table public\.query_history/.test(sql));
  });

  it('allows NULL', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /clinical_category\s+is\s+null/.test(sql),
      'CHECK must explicitly accept NULL.'
    );
  });

  it('accepts each value in normalizeTriageOutput\'s canonicalCategories (positive)', () => {
    const migration = extractMigrationAllowlist(readMigration(),
      'add constraint query_history_clinical_category_check');
    const lib = extractLibAllowlist(readLib());
    for (const v of lib) {
      assert.ok(
        migration.includes(v),
        'enum value "' + v + '" missing from migration CHECK. Migration: ' + JSON.stringify(migration)
      );
    }
  });

  it('rejects any value normalizeTriageOutput does not produce (negative)', () => {
    const migration = extractMigrationAllowlist(readMigration(),
      'add constraint query_history_clinical_category_check');
    const lib = extractLibAllowlist(readLib());
    for (const v of migration) {
      assert.ok(
        lib.includes(v),
        'migration CHECK accepts "' + v + '" but normalizeTriageOutput does not produce it. Lib: ' + JSON.stringify(lib)
      );
    }
  });

  it('migration allowlist is set-equal to canonicalCategories', () => {
    const migration = new Set(extractMigrationAllowlist(readMigration(),
      'add constraint query_history_clinical_category_check'));
    const lib = new Set(extractLibAllowlist(readLib()));
    assert.deepEqual(
      Array.from(migration).sort(),
      Array.from(lib).sort(),
      'DB CHECK allowlist must be byte-identical to canonicalCategories.'
    );
  });

  it('backfill IN-list is set-equal to the CHECK IN-list', () => {
    // The migration uses the allowlist in two places — the defensive
    // backfill UPDATE and the binding ADD CONSTRAINT. If they drift,
    // the backfill might leave rows that the CHECK then rejects, and
    // the ADD CONSTRAINT statement fails on application of the
    // migration.
    const backfill = new Set(extractMigrationAllowlist(readMigration(),
      'update public.query_history'));
    const check = new Set(extractMigrationAllowlist(readMigration(),
      'add constraint query_history_clinical_category_check'));
    assert.deepEqual(
      Array.from(backfill).sort(),
      Array.from(check).sort(),
      'backfill IN-list must match CHECK IN-list to keep the migration applicable.'
    );
  });

  it('has a defensive backfill UPDATE before the CHECK is added', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/update\s+public\.query_history/.test(sql));
    assert.ok(/set\s+clinical_category\s*=\s*null/.test(sql));
    const updateIdx = sql.indexOf('update public.query_history');
    const addIdx    = sql.indexOf('add constraint query_history_clinical_category_check');
    assert.ok(updateIdx >= 0 && addIdx >= 0 && updateIdx < addIdx,
      'UPDATE must appear before ADD CONSTRAINT.');
  });

  it('is idempotent — wraps add in a DROP CONSTRAINT IF EXISTS / ADD pair', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/drop\s+constraint\s+if\s+exists\s+query_history_clinical_category_check/.test(sql));
  });
});
