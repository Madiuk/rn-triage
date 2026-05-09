# Migrations

These SQL files are the **single source of truth** for the Supabase
schema. To bring a new environment online, run them in numeric order.

## Conventions

- File naming: `NNNN_short_name.sql` (zero-padded 4 digits, snake_case).
- Each migration must be **idempotent** — use `CREATE TABLE IF NOT
  EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, etc. Re-running a
  migration on an environment that already has it should be a no-op.
- Each migration is **append-only**. Don't edit `0001_baseline.sql`
  after it's been applied; add `0002_*.sql` instead.
- Keep migrations small. One logical concern per file.

## Running them

The fastest path during the trial:
1. Open Supabase → SQL Editor → New Query.
2. Paste a migration file's contents.
3. Run.
4. Repeat for each newer file.

Once we move to a CI/CD setup we'll wire `supabase db push` or a
similar tool. Until then, manual.

## Current schema (as of 0001_baseline)

| Table             | Purpose                                              |
|-------------------|------------------------------------------------------|
| profiles          | Per-user profile (name, role, company_id)            |
| companies         | Tenant orgs                                          |
| company_members   | User ↔ company link (kept for back-compat)           |
| kb_entries        | Knowledge base entries (per-tenant via company_id)   |
| query_history     | Triage records + corrections + feedback              |
| review_requests   | Low-confidence triages for clinical expert input     |
| api_keys          | Webhook API keys (sha256 hashed)                     |
| tenants           | Tenant configuration (theme, defaults) — added 0002  |
| audit_log         | Append-only event log — added 0003                   |

`tenants` and `audit_log` are added by later migrations. Older code
paths fall back to constants in `data/defaults.js` if these tables are
empty, so no behavior change is required to deploy them.
