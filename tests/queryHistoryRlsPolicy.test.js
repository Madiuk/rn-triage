// tests/queryHistoryRlsPolicy.test.js
//
// CONTRACT TEST — migration 0011_query_history_explicit_deny_rls.sql
// must declare an explicit deny RLS policy on public.query_history for
// the authenticated and anon roles. See
// docs/archive/DB_INTEGRITY_AUDIT_2026-05-15.md finding 1 for the rationale.
//
// We don't run migrations against a live DB in CI, so this is a
// source-text contract test (same style as triagePathContract.test.js).
// Its job is to make sure that:
//
//   (a) the deny policy is present and well-shaped — FOR ALL, USING
//       (false), WITH CHECK (false), TO authenticated, anon, targeting
//       public.query_history;
//   (b) the migration never accidentally relaxes the policy by using
//       USING (true) or WITH CHECK (true) — a negative control that
//       would catch a careless "fix" in a future edit.
//
// If a future migration intentionally replaces this policy with
// something different, that future migration is what should make the
// decision; this test would need to be updated alongside it as part
// of the same diff.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0011_query_history_explicit_deny_rls.sql';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
}

// Pull the CREATE POLICY statement out of the migration as a single
// normalized string (whitespace collapsed, lowercased) so the assertions
// below don't have to care about formatting. Anchored on the literal
// policy name to give a clear failure message if the policy is renamed
// or removed.
function extractPolicyStatement(sql) {
  const lower = sql.toLowerCase();
  const idx = lower.indexOf('create policy query_history_user_deny');
  if (idx === -1) {
    throw new Error(
      'CREATE POLICY query_history_user_deny not found in ' + MIGRATION_REL +
      ' — the deny policy was renamed or removed.'
    );
  }
  // Take everything from the CREATE POLICY through the next semicolon.
  const tail = sql.slice(idx);
  const semi = tail.indexOf(';');
  if (semi === -1) {
    throw new Error('CREATE POLICY statement is not terminated by a semicolon.');
  }
  return tail.slice(0, semi + 1).replace(/\s+/g, ' ').toLowerCase();
}

describe('CONTRACT: query_history explicit deny RLS policy (migration 0011)', () => {
  it('migration file exists', () => {
    const full = path.join(ROOT, MIGRATION_REL);
    assert.ok(fs.existsSync(full), MIGRATION_REL + ' is missing.');
  });

  it('declares a CREATE POLICY statement named query_history_user_deny', () => {
    const sql = readMigration();
    const stmt = extractPolicyStatement(sql);
    assert.ok(
      stmt.startsWith('create policy query_history_user_deny'),
      'expected CREATE POLICY query_history_user_deny, got: ' + stmt.slice(0, 80)
    );
  });

  it('targets public.query_history', () => {
    const stmt = extractPolicyStatement(readMigration());
    assert.ok(
      /on\s+public\.query_history\b/.test(stmt),
      'policy must apply to public.query_history; got: ' + stmt
    );
  });

  it('applies FOR ALL (every operation, not just SELECT)', () => {
    const stmt = extractPolicyStatement(readMigration());
    assert.ok(
      /\bfor\s+all\b/.test(stmt),
      'policy must use FOR ALL so it covers SELECT/INSERT/UPDATE/DELETE; got: ' + stmt
    );
  });

  it('applies to both authenticated and anon roles', () => {
    const stmt = extractPolicyStatement(readMigration());
    // The roles can appear in either order on the TO clause.
    assert.ok(/\bto\s+[^;]*\bauthenticated\b/.test(stmt), 'policy must list "authenticated" in TO clause');
    assert.ok(/\bto\s+[^;]*\banon\b/.test(stmt),          'policy must list "anon" in TO clause');
  });

  it('uses USING (false) — the read-side deny', () => {
    const stmt = extractPolicyStatement(readMigration());
    assert.ok(
      /\busing\s*\(\s*false\s*\)/.test(stmt),
      'policy must use USING (false); got: ' + stmt
    );
  });

  it('uses WITH CHECK (false) — the write-side deny', () => {
    const stmt = extractPolicyStatement(readMigration());
    assert.ok(
      /\bwith\s+check\s*\(\s*false\s*\)/.test(stmt),
      'policy must use WITH CHECK (false); got: ' + stmt
    );
  });

  it('NEGATIVE CONTROL: does not contain USING (true) or WITH CHECK (true)', () => {
    // Catches a future careless edit that "fixes" the policy by
    // flipping it permissive. The check is across the whole migration
    // file (not just the extracted statement) so it also catches a
    // sibling policy that opens the table back up.
    const sql = readMigration().toLowerCase();
    assert.ok(
      !/\busing\s*\(\s*true\s*\)/.test(sql),
      'migration must not contain USING (true) — that would grant unrestricted read access.'
    );
    assert.ok(
      !/\bwith\s+check\s*\(\s*true\s*\)/.test(sql),
      'migration must not contain WITH CHECK (true) — that would grant unrestricted write access.'
    );
  });

  it('is idempotent — wraps create in a DROP IF EXISTS / CREATE pair', () => {
    // Re-running a migration must be a no-op per migrations/README.md.
    // The simplest way to guarantee that for CREATE POLICY (which has
    // no IF NOT EXISTS form on older Postgres) is a paired DROP IF
    // EXISTS. If a future edit removes the drop, the migration will
    // fail on its second run; this test makes that regression visible
    // up front.
    const sql = readMigration().toLowerCase();
    assert.ok(
      /drop\s+policy\s+if\s+exists\s+query_history_user_deny\s+on\s+public\.query_history/.test(sql),
      'migration must DROP POLICY IF EXISTS before CREATE so re-runs are no-ops.'
    );
  });
});
