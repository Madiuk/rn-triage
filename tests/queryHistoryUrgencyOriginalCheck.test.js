// tests/queryHistoryUrgencyOriginalCheck.test.js
//
// CONTRACT TEST — migration 0013_query_history_urgency_original_check.sql
// must declare a CHECK constraint on public.query_history.urgency_original
// whose allowlist is set-equal to the canonical enum in
// normalizeTriageOutput (data/triage-lib.js).
//
// Style: identical to queryHistoryUrgencyOverrideCheck.test.js but
// anchored on a DIFFERENT canonical source. The two enums are
// deliberately different — see migration 0013's header comment for
// the rationale on the asymmetry.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0013_query_history_urgency_original_check.sql';
const LIB_REL       = 'data/triage-lib.js';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
}
function readLib() {
  return fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
}

// Extract the migration's CHECK allowlist (same approach as 0012's
// test — anchored on the constraint name, then the IN-list).
function extractMigrationAllowlist(sql) {
  const idx = sql.toLowerCase().indexOf('add constraint query_history_urgency_original_check');
  if (idx === -1) {
    throw new Error(
      'ADD CONSTRAINT query_history_urgency_original_check not found in ' + MIGRATION_REL
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

// Extract the canonical urgency enum from normalizeTriageOutput in
// data/triage-lib.js. The literal lives in:
//   out.urgency = normalizeEnum(out.urgency, [
//     'routine', 'same-day', 'urgent',
//   ]) || 'routine';
// We anchor on `out.urgency = normalizeEnum(out.urgency, [` so a
// rename or restructure surfaces as a precise failure instead of a
// confusing parity diff.
function extractLibAllowlist(src) {
  const anchor = 'out.urgency = normalizeEnum(out.urgency, [';
  const idx = src.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'Anchor `' + anchor + '` not found in ' + LIB_REL +
      ' — has normalizeTriageOutput been restructured?'
    );
  }
  const tail = src.slice(idx + anchor.length);
  const close = tail.indexOf(']');
  if (close === -1) throw new Error('urgency enum literal has no closing bracket.');
  const inner = tail.slice(0, close);

  const items = [];
  // Tolerate single or double quotes — data/triage-lib.js uses single.
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(inner)) !== null) items.push(m[1]);
  if (items.length === 0) throw new Error('urgency enum literal contains no strings.');
  return items;
}

describe('CONTRACT: query_history.urgency_original CHECK constraint (migration 0013)', () => {
  it('migration file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, MIGRATION_REL)),
      MIGRATION_REL + ' is missing.'
    );
  });

  it('declares a named CHECK constraint on public.query_history', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /add constraint query_history_urgency_original_check/.test(sql),
      'expected ADD CONSTRAINT query_history_urgency_original_check.'
    );
    assert.ok(
      /alter table public\.query_history/.test(sql),
      'constraint must be added to public.query_history.'
    );
  });

  it('allows NULL', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /urgency_original\s+is\s+null/.test(sql),
      'CHECK must explicitly accept NULL.'
    );
  });

  it('accepts each value in normalizeTriageOutput\'s urgency enum (positive)', () => {
    const migration = extractMigrationAllowlist(readMigration());
    const lib       = extractLibAllowlist(readLib());
    for (const v of lib) {
      assert.ok(
        migration.includes(v),
        'urgency enum value "' + v + '" missing from migration CHECK. ' +
        'AI could emit it; DB would reject it. Migration list: ' + JSON.stringify(migration)
      );
    }
  });

  it('rejects any value the AI normalization layer doesn\'t produce (negative)', () => {
    const migration = extractMigrationAllowlist(readMigration());
    const lib       = extractLibAllowlist(readLib());
    for (const v of migration) {
      assert.ok(
        lib.includes(v),
        'migration CHECK accepts "' + v + '" but normalizeTriageOutput does not produce it. ' +
        'Lib list: ' + JSON.stringify(lib)
      );
    }
  });

  it('migration allowlist is set-equal to normalizeTriageOutput\'s urgency enum', () => {
    const migration = new Set(extractMigrationAllowlist(readMigration()));
    const lib       = new Set(extractLibAllowlist(readLib()));
    assert.deepEqual(
      Array.from(migration).sort(),
      Array.from(lib).sort(),
      'DB CHECK allowlist must be byte-identical to the urgency enum in normalizeTriageOutput.'
    );
  });

  it('CHECK is strictly tighter than urgency_override\'s CHECK (asymmetry encoded in schema)', () => {
    // The asymmetry is a deliberate design property: staff can refine
    // the AI's coarse bucket to a finer value (24h, 24-72h) that the
    // AI itself cannot emit. If a future edit relaxes urgency_original
    // to include 24h/24-72h, the AI's output enum has changed and the
    // contract test on triage-lib.js would also be failing — but if
    // someone "fixes" that by editing both files in sync without
    // thinking, this assertion catches the loss of the asymmetry.
    const original = new Set(extractMigrationAllowlist(readMigration()));
    assert.ok(!original.has('24h'),    'urgency_original must not accept "24h" (AI cannot emit it).');
    assert.ok(!original.has('24-72h'), 'urgency_original must not accept "24-72h" (AI cannot emit it).');
  });

  it('has a defensive backfill UPDATE before the CHECK is added', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /update\s+public\.query_history/.test(sql),
      'migration must include an UPDATE that backfills dirty rows.'
    );
    assert.ok(
      /set\s+urgency_original\s*=\s*null/.test(sql),
      'backfill UPDATE must clear urgency_original to NULL.'
    );
    const updateIdx = sql.indexOf('update public.query_history');
    const addIdx    = sql.indexOf('add constraint query_history_urgency_original_check');
    assert.ok(
      updateIdx >= 0 && addIdx >= 0 && updateIdx < addIdx,
      'backfill UPDATE must appear before the ADD CONSTRAINT statement.'
    );
  });

  it('is idempotent — wraps add in a DROP CONSTRAINT IF EXISTS / ADD pair', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /drop\s+constraint\s+if\s+exists\s+query_history_urgency_original_check/.test(sql),
      'migration must DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.'
    );
  });
});
