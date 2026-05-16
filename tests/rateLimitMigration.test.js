// tests/rateLimitMigration.test.js
//
// CONTRACT TEST — migration 0020_rate_limit_ingest.sql declares the
// rate_limit_counter table and the increment_rate_limit RPC with the
// expected security posture:
//
//   Table:
//     - public.rate_limit_counter with primary key (api_key_hash, window_start)
//     - RLS enabled
//     - REVOKE all from anon, authenticated, public
//     - GRANT select/insert/update/delete to service_role
//
//   Function public.increment_rate_limit(text, timestamptz):
//     - DROP FUNCTION IF EXISTS before CREATE (idempotent)
//     - SECURITY DEFINER + search_path locked to (public, pg_temp)
//     - REVOKE execute from anon, authenticated, public
//     - GRANT execute to service_role
//
// Source-text contract test (same pattern as queryHistoryRlsPolicy.test.js
// and rlsCoverage.test.js). If a future migration intentionally
// changes any of this, that migration is what should make the
// decision; this test needs to be updated alongside it as part of the
// same diff.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'migrations/0020_rate_limit_ingest.sql';

function readMigration() {
  return fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8').toLowerCase();
}

describe('CONTRACT: rate_limit_counter table (migration 0020)', () => {
  it('migration file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, MIGRATION_REL)),
      MIGRATION_REL + ' is missing.'
    );
  });

  it('creates public.rate_limit_counter table (idempotent)', () => {
    const sql = readMigration();
    assert.ok(
      /create\s+table\s+if\s+not\s+exists\s+public\.rate_limit_counter/.test(sql),
      'expected CREATE TABLE IF NOT EXISTS public.rate_limit_counter'
    );
  });

  it('primary key is (api_key_hash, window_start)', () => {
    const sql = readMigration();
    assert.ok(
      /primary\s+key\s*\(\s*api_key_hash\s*,\s*window_start\s*\)/.test(sql),
      'expected PRIMARY KEY (api_key_hash, window_start) — composite key prevents same-window double-insert'
    );
  });

  it('enables RLS on rate_limit_counter', () => {
    const sql = readMigration();
    assert.ok(
      /alter\s+table\s+public\.rate_limit_counter\s+enable\s+row\s+level\s+security/.test(sql),
      'expected ENABLE ROW LEVEL SECURITY — no policies means default-deny for anon/authenticated'
    );
  });

  it('REVOKEs all privileges from anon/authenticated/public on the table', () => {
    const sql = readMigration();
    assert.ok(
      /revoke\s+all\s+on\s+public\.rate_limit_counter\s+from\s+anon/.test(sql),
      'expected REVOKE ALL ON public.rate_limit_counter FROM anon'
    );
    assert.ok(
      /revoke\s+all\s+on\s+public\.rate_limit_counter\s+from\s+authenticated/.test(sql),
      'expected REVOKE ALL ON public.rate_limit_counter FROM authenticated'
    );
    assert.ok(
      /revoke\s+all\s+on\s+public\.rate_limit_counter\s+from\s+public/.test(sql),
      'expected REVOKE ALL ON public.rate_limit_counter FROM public'
    );
  });

  it('GRANTs CRUD to service_role on the table', () => {
    const sql = readMigration();
    assert.ok(
      /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.rate_limit_counter\s+to\s+service_role/.test(sql),
      'expected GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_counter TO service_role'
    );
  });
});

describe('CONTRACT: increment_rate_limit function (migration 0020)', () => {
  it('drops the function before creating (idempotent)', () => {
    const sql = readMigration();
    assert.ok(
      /drop\s+function\s+if\s+exists\s+public\.increment_rate_limit/.test(sql),
      'expected DROP FUNCTION IF EXISTS public.increment_rate_limit before CREATE'
    );
  });

  it('creates public.increment_rate_limit with (text, timestamptz) parameters', () => {
    const sql = readMigration();
    assert.ok(
      /create\s+function\s+public\.increment_rate_limit\s*\(/.test(sql),
      'expected CREATE FUNCTION public.increment_rate_limit'
    );
    assert.ok(
      /p_api_key_hash\s+text/.test(sql),
      'expected p_api_key_hash text parameter'
    );
    assert.ok(
      /p_window\s+timestamptz/.test(sql),
      'expected p_window timestamptz parameter'
    );
  });

  it('uses SECURITY DEFINER', () => {
    const sql = readMigration();
    assert.ok(
      /security\s+definer/.test(sql),
      'expected SECURITY DEFINER — function runs with owner privileges so the service-role-only grant on rate_limit_counter is enforced'
    );
  });

  it('locks search_path to (public, pg_temp)', () => {
    const sql = readMigration();
    assert.ok(
      /set\s+search_path\s*=\s*public\s*,\s*pg_temp/.test(sql),
      'expected SET search_path = public, pg_temp — mitigates search_path injection on a SECURITY DEFINER function'
    );
  });

  it('REVOKEs execute from anon/authenticated/public', () => {
    const sql = readMigration();
    // Roles may appear in any order on one REVOKE or split across
    // multiple statements; require each role appears in some
    // REVOKE EXECUTE referring to this function.
    assert.ok(
      /revoke\s+execute\s+on\s+function\s+public\.increment_rate_limit[^;]*from[^;]*\banon\b/.test(sql),
      'expected REVOKE EXECUTE ... FROM anon'
    );
    assert.ok(
      /revoke\s+execute\s+on\s+function\s+public\.increment_rate_limit[^;]*from[^;]*\bauthenticated\b/.test(sql),
      'expected REVOKE EXECUTE ... FROM authenticated'
    );
    assert.ok(
      /revoke\s+execute\s+on\s+function\s+public\.increment_rate_limit[^;]*from[^;]*\bpublic\b/.test(sql),
      'expected REVOKE EXECUTE ... FROM public'
    );
  });

  it('GRANTs execute to service_role', () => {
    const sql = readMigration();
    assert.ok(
      /grant\s+execute\s+on\s+function\s+public\.increment_rate_limit[^;]*to\s+service_role/.test(sql),
      'expected GRANT EXECUTE ON FUNCTION public.increment_rate_limit ... TO service_role'
    );
  });
});
