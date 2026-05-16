// tests/rlsCoverage.test.js
//
// CONTRACT TEST — RLS posture across the migrations directory.
//
// Two layers, asserted as source-text checks (we don't run migrations
// against a live DB in CI — same convention as queryHistoryRlsPolicy.test.js):
//
//   1. Every sensitive table listed in RLS_REQUIRED_TABLES must have
//      `alter table public.<name> enable row level security` declared
//      in some migration. New sensitive tables added here so a future
//      migration that creates a table without RLS fails this test.
//
//   2. No migration anywhere may contain `USING (true)` or
//      `WITH CHECK (true)` outside comments. These patterns are
//      RLS-policy-specific and granting either defeats RLS for the
//      target role. Comments are stripped before the check so prose
//      in 0015/0016 that *describes* the historical bad-pattern
//      doesn't false-positive.
//
// The detailed per-policy shape test for query_history lives in
// queryHistoryRlsPolicy.test.js; this file covers everything else.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

const RLS_REQUIRED_TABLES = [
  'profiles',
  'companies',
  'company_members',
  'tenants',
  'kb_entries',
  'query_history',
  'review_requests',
  'api_keys',
  'audit_log',
  'category_metadata',
];

function readAllMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => ({
      file: f,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'),
    }));
}

// Strip Postgres line comments (-- to end of line) so the negative
// control isn't tripped by historical prose in 0015/0016 that refers
// to the bad pattern. Postgres also supports /* ... */ block comments
// but none are used in this project's migrations; if added later this
// helper should be extended.
function stripSqlComments(sql) {
  return sql.split('\n').map(line => {
    const idx = line.indexOf('--');
    return idx >= 0 ? line.slice(0, idx) : line;
  }).join('\n');
}

describe('CONTRACT: RLS enabled on every sensitive table', () => {
  const all = readAllMigrations();
  const concatenated = all.map(m => m.sql).join('\n').toLowerCase();

  for (const table of RLS_REQUIRED_TABLES) {
    it(`enables RLS on public.${table}`, () => {
      const pattern = new RegExp(
        `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
        'i'
      );
      assert.ok(
        pattern.test(concatenated),
        `Expected migrations to ENABLE ROW LEVEL SECURITY on public.${table}. ` +
        'If a future migration intentionally disables RLS for this table, update ' +
        'RLS_REQUIRED_TABLES in tests/rlsCoverage.test.js in the same diff.'
      );
    });
  }
});

describe('CONTRACT: no migration declares a permissive (true) RLS policy', () => {
  const all = readAllMigrations();

  for (const { file, sql } of all) {
    const stripped = stripSqlComments(sql).toLowerCase();

    it(`${file} does not contain USING (true)`, () => {
      assert.ok(
        !/\busing\s*\(\s*true\s*\)/.test(stripped),
        `${file} contains USING (true) outside comments — would grant unrestricted ` +
        'read access. If this is intentional, update this test in the same migration.'
      );
    });

    it(`${file} does not contain WITH CHECK (true)`, () => {
      assert.ok(
        !/\bwith\s+check\s*\(\s*true\s*\)/.test(stripped),
        `${file} contains WITH CHECK (true) outside comments — would grant ` +
        'unrestricted write access. If this is intentional, update this test in the same migration.'
      );
    });
  }
});
