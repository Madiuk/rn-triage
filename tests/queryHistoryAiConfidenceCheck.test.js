// tests/queryHistoryAiConfidenceCheck.test.js
//
// CONTRACT TEST — migration 0019 must declare a CHECK constraint on
// query_history.ai_confidence whose range matches validateTriageOutput's
// proxy-layer range check exactly. Unlike the enum CHECKs (0012-0014,
// 0018), this column is a numeric, so the test verifies:
//   * the CHECK accepts NULL,
//   * the CHECK has the [0, 1] inclusive bounds,
//   * validateTriageOutput uses the same bounds.
// If either side drifts (e.g., the proxy starts accepting confidence
// > 1 while the DB still rejects, or vice versa), this test fails.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0019_query_history_ai_confidence_check.sql';
const LIB_REL       = 'data/triage-lib.js';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
}
function readLib() {
  return fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
}

describe('CONTRACT: query_history.ai_confidence CHECK constraint (migration 0019)', () => {
  it('migration file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, MIGRATION_REL)),
      MIGRATION_REL + ' is missing.'
    );
  });

  it('declares a named CHECK constraint on public.query_history', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/add constraint query_history_ai_confidence_check/.test(sql));
    assert.ok(/alter table public\.query_history/.test(sql));
  });

  it('allows NULL', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(
      /ai_confidence\s+is\s+null/.test(sql),
      'CHECK must explicitly accept NULL — confidence is optional.'
    );
  });

  it('declares the [0, 1] inclusive range on ai_confidence', () => {
    const sql = readMigration().toLowerCase();
    // Permissive on whitespace and "and" vs "&&" but strict on bounds.
    // The "or (...)" wraps the range half of the IS NULL OR (range).
    assert.ok(
      /ai_confidence\s*>=\s*0/.test(sql),
      'CHECK must include `ai_confidence >= 0`.'
    );
    assert.ok(
      /ai_confidence\s*<=\s*1/.test(sql),
      'CHECK must include `ai_confidence <= 1`.'
    );
  });

  it('does NOT use exclusive bounds (> 0 or < 1) which would reject valid AI output', () => {
    // validateTriageOutput accepts 0 and 1 inclusively
    // (see "accepts ai_confidence at boundaries 0 and 1" in
    // validateTriageOutput.test.js). Exclusive bounds would create a
    // gap where the proxy accepts a value the DB then rejects.
    const sql = readMigration().toLowerCase();
    // Targeted negatives — match the actual constraint text, not
    // adjacent comment text. We only flag the precise patterns
    // "> 0" / "< 1" applied to ai_confidence.
    assert.ok(
      !/ai_confidence\s*>\s*0[^=]/.test(sql),
      'CHECK uses exclusive lower bound `> 0` — should be `>= 0`.'
    );
    assert.ok(
      !/ai_confidence\s*<\s*1[^=]/.test(sql),
      'CHECK uses exclusive upper bound `< 1` — should be `<= 1`.'
    );
  });

  it('matches validateTriageOutput\'s range check in data/triage-lib.js', () => {
    // Pin the proxy-layer range to the same [0, 1] inclusive bounds
    // so a future loosening of the proxy validator (e.g., to allow
    // confidence: 1.5) doesn't drift from the DB CHECK without
    // tripping a test.
    const src = readLib();
    // The validator rejects out-of-range with the literal predicate:
    //   parsed.ai_confidence < 0 || parsed.ai_confidence > 1
    assert.ok(
      /parsed\.ai_confidence\s*<\s*0\s*\|\|\s*parsed\.ai_confidence\s*>\s*1/.test(src),
      'validateTriageOutput must reject ai_confidence outside [0, 1] (inclusive). ' +
      'If you changed the validator bounds, update the DB CHECK in migration 0019 to match.'
    );
  });

  it('has a defensive backfill UPDATE before the CHECK is added', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/update\s+public\.query_history/.test(sql));
    assert.ok(/set\s+ai_confidence\s*=\s*null/.test(sql));
    const updateIdx = sql.indexOf('update public.query_history');
    const addIdx    = sql.indexOf('add constraint query_history_ai_confidence_check');
    assert.ok(updateIdx >= 0 && addIdx >= 0 && updateIdx < addIdx,
      'UPDATE must appear before ADD CONSTRAINT.');
  });

  it('backfill predicate clears out-of-range values to NULL', () => {
    const sql = readMigration().toLowerCase();
    // Backfill must target rows where ai_confidence < 0 OR > 1.
    // Pattern is permissive on whitespace and operator placement.
    assert.ok(
      /ai_confidence\s*<\s*0/.test(sql),
      'backfill must include the < 0 branch.'
    );
    assert.ok(
      /ai_confidence\s*>\s*1/.test(sql),
      'backfill must include the > 1 branch.'
    );
  });

  it('is idempotent — wraps add in a DROP CONSTRAINT IF EXISTS / ADD pair', () => {
    const sql = readMigration().toLowerCase();
    assert.ok(/drop\s+constraint\s+if\s+exists\s+query_history_ai_confidence_check/.test(sql));
  });
});
