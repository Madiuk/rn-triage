# Relai — DB Integrity Audit

Schema audit assembled from [migrations/](migrations/) 0001 → 0010, read-only.
For each table: existing NOT NULL / CHECK / UNIQUE / FK constraints, the RLS
posture, the gaps, and the worst plausible consequence.

## TL;DR

Two structural facts up front:

1. **RLS is enabled on every tenant-scoped table, and zero policies are
   declared anywhere in the migration tree.** That makes every table
   default-deny under any user-JWT call. The Netlify functions side-step
   this by using `SUPABASE_SERVICE_KEY` (which bypasses RLS) and applying
   `company_id` filters in application code. The whole multi-tenant
   isolation story rests on those application filters; if a permissive
   policy is ever added without a `company_id` predicate, tenant
   isolation is gone.
2. **CHECK constraints exist on exactly one column** (`query_history.status`,
   added in 0004). Every other enum-shaped column — `urgency_original`,
   `urgency_override`, `clinical_routing_level`, `source_channel`,
   `clinical_category`, `review_requests.status`, `review_requests.context`,
   `applied_to`, `profiles.role` — is unconstrained `text`. Application code
   validates some of these; some it doesn't.

There is also one consistent NOT NULL gap: `company_id` is **nullable on
every tenant-scoped table** (`profiles`, `kb_entries`, `query_history`,
`review_requests`, `audit_log`), only NOT NULL on `api_keys`, `tenants`,
and `category_metadata`. Migration 0008 backfilled the orphans but the
column was never tightened, so the failure mode that produced the orphans
in the first place is still reachable.

---

## 1. Per-table audit

### 1.1 `public.companies`
- **Source:** [0001_baseline.sql:6](migrations/0001_baseline.sql:6)
- **Columns:** `id uuid PK`, `name text NOT NULL`, `created_at timestamptz`,
  plus `non_clinical_handoff_template text` (added 0010, defaulted).
- **NOT NULL:** `id`, `name`.
- **CHECK:** none.
- **UNIQUE:** `id` (PK).
- **Foreign keys (incoming):** profiles, company_members, kb_entries,
  query_history, review_requests, api_keys (NOT NULL), tenants
  (NOT NULL, ON DELETE CASCADE), category_metadata (NOT NULL, ON DELETE
  CASCADE), audit_log.
- **RLS:** enabled, no policies.
- **Gaps:**
  - `name` has no length cap.
  - No `slug` / `display_id` column — `name` is the only human-readable
    identifier; collisions are allowed.
  - Most child FKs use the default `NO ACTION` on delete, so a tenant
    teardown can't be done with a single `DELETE`. `tenants` and
    `category_metadata` cascade; everything else blocks or orphans.
- **Worst consequence:** trying to retire a tenant requires manual
  child-table cleanup; risk of partial deletes that leave dangling rows.

### 1.2 `public.profiles`
- **Source:** [0001_baseline.sql:13](migrations/0001_baseline.sql:13);
  [0010_roles_admin_categories.sql:46](migrations/0010_roles_admin_categories.sql:46)
  adds `is_admin`, `is_super_user` (both `boolean NOT NULL default false`).
- **Columns:** `id`, `full_name`, `role`, `company_id`,
  `triages_completed`, `last_seen`, `created_at`, `is_admin`,
  `is_super_user`.
- **NOT NULL:** `id`, `is_admin`, `is_super_user`. **NOT** `role`,
  `company_id`, `full_name`.
- **CHECK:** none. `role` is free-form text despite the permissions
  layer ([permissions.js](netlify/functions/_lib/permissions.js))
  branching on the literal strings `'Clinical' | 'Non-Clinical' | 'staff'`.
- **UNIQUE:** `id` (PK; mirrors `auth.users.id`).
- **Foreign keys:** `id → auth.users(id) ON DELETE CASCADE`;
  `company_id → companies(id)` (no ON DELETE).
- **RLS:** enabled, no policies.
- **Gaps:**
  - `role` should be `NOT NULL` with a CHECK in
    `('Clinical','Non-Clinical','staff')`. Today any string (including
    `''`) sits in the column and the permissions code silently treats
    unrecognized values as non-clinical.
  - `company_id` should be NOT NULL once 0008 backfill is universal.
    Auth.js still creates profiles with NULL `company_id` in multi-tenant
    mode (`auth.js:75-103`), so this can't be tightened without a code
    change.
  - No FK protection on `company_id` delete (NO ACTION); deleting a
    `companies` row with profiles attached would fail rather than
    detach.
  - `full_name` has no length cap. Stamped from `user_metadata` typed at
    signup; see [RELAI_VALIDATION_AUDIT §1.5](RELAI_VALIDATION_AUDIT.md).
- **Worst consequence:** a user with `role` set to an unrecognized value
  (`'Clinical '`, with trailing space; `'clinical'` lowercase; etc.) is
  silently treated as non-clinical, which under-gates rather than
  over-gates. Failure direction is safe by accident.

### 1.3 `public.company_members`
- **Source:** [0001_baseline.sql:25](migrations/0001_baseline.sql:25)
- **Columns:** `company_id`, `user_id`, `role`, `created_at`.
- **NOT NULL:** `company_id`, `user_id` (via PK).
- **CHECK:** none.
- **UNIQUE:** `(company_id, user_id)` composite PK.
- **Foreign keys:** both columns cascade on parent delete.
- **RLS:** enabled, no policies.
- **Gaps:**
  - The codebase comment in [auth.js](netlify/functions/_lib/auth.js)
    says this table is "kept for back-compat; many flows now use
    `profiles.company_id` directly." It's a redundant source of truth.
    Nothing keeps `company_members.role` in sync with `profiles.role`.
  - `role` is free-form and no CHECK.
- **Worst consequence:** drift between `profiles.role` and
  `company_members.role`. Today only `profiles` is read; if a future
  code path reads `company_members` instead, it can disagree with the
  permissions answer.

### 1.4 `public.kb_entries`
- **Source:** [0001_baseline.sql:34](migrations/0001_baseline.sql:34)
- **Columns:** `id`, `company_id`, `section`, `name`, `content`,
  `position`, `nurse_name`, `user_id`, `updated_at`, `created_at`.
- **NOT NULL:** `id`, `section`, `name`, `content`.
- **CHECK:** none. `section` is free-form despite the codebase's strict
  set of `sideeffects | templates | protocols | notes | routing | urls`.
- **UNIQUE:** `id` (PK).
- **Foreign keys:** `company_id → companies(id)` (no ON DELETE).
  `user_id` is **NOT** a FK — it's a bare `uuid` with no referential
  integrity to `auth.users` or `profiles`.
- **RLS:** enabled, no policies.
- **Gaps:**
  - `company_id` should be NOT NULL — see §1.2.
  - `section` should have a CHECK against the known allowlist. Today a
    typo writes a new "section" that the prompt-builder silently drops
    (because [data/defaults.js](data/defaults.js) `kb_sections` is the
    iterator).
  - No UNIQUE on `(company_id, section, position)`, so two entries
    can share a position — `ORDER BY position` then becomes
    non-deterministic, splitting between renders.
  - `user_id` not a FK: a deleted user leaves authorship dangling.
  - `name`, `content` have no length caps. The KB CRUD handler doesn't
    cap either (see RELAI_VALIDATION_AUDIT §1.10).
- **Worst consequence:** drifted `section` values silently disappear
  from the prompt (data loss with no error signal). Duplicate `position`
  values cause inconsistent rendering between two staff members' UIs.

### 1.5 `public.query_history`
- **Source:** [0001_baseline.sql:50](migrations/0001_baseline.sql:50);
  status CHECK added [0004_query_history_state.sql:38](migrations/0004_query_history_state.sql:38);
  observability columns [0005_triage_observability.sql:16](migrations/0005_triage_observability.sql:16);
  `internal_note` [0007_query_history_internal_note.sql:25](migrations/0007_query_history_internal_note.sql:25);
  escalation columns [0010_roles_admin_categories.sql:55](migrations/0010_roles_admin_categories.sql:55).
- **Columns:** 40+ — patient_message, draft, classification, urgency,
  observability, escalation, etc. See migrations for full list.
- **NOT NULL:** `id` only. **None of the substantive columns are NOT
  NULL.**
- **CHECK:** **only `status`**, allowlist `('pending','triaged',
  'reviewed','sent','patient_replied','closed','completed')`.
- **UNIQUE:** `id` (PK); partial unique on `(company_id, external_id)
  WHERE external_id is not null` — drives webhook idempotency.
- **Foreign keys:** `company_id → companies(id)` (no ON DELETE).
  `user_id`, `escalated_by` are **bare uuids, no FK**.
- **RLS:** enabled, no policies.
- **Gaps (this is the densest table):**
  - `company_id`, `user_id`, `patient_message` should all be NOT NULL.
    A row with NULL `patient_message` carries no information; today the
    ingest path inserts whatever was sent but the manual triage path
    requires it client-side. Schema doesn't enforce.
  - `source_channel` has no CHECK — any string lands in the column.
    Aggregations on channel will split silently on typos.
  - `urgency_original` / `urgency_override`: no CHECK. The
    `URGENCY_OVERRIDE_VALUES` allowlist in
    [history.js:47](netlify/functions/_lib/routes/history.js:47)
    (`routine|24h|24-72h|same-day|urgent`) only gates the override
    PATCH path. The default-branch insert (line 372) accepts any value
    from the client.
  - `clinical_routing_level`: no CHECK. The UI's `buildSeverityBadge`
    knows only `severe|moderate|mild|none`. Any other value writes
    successfully but renders no badge.
  - `clinical_category`: no CHECK. The AI emits from a closed set
    inside `BASE_PROMPT_TEMPLATE`; any drift is invisible at the DB
    layer.
  - `ai_confidence` is `numeric(3,2)` but no range CHECK in `[0,1]`.
    The review-threshold logic (< 0.75 → review_request) silently
    shifts if the model returns e.g. `0..100`.
  - `non_clinical_items`, `follow_up_questions` are `jsonb` defaulted
    to `'[]'::jsonb` but no CHECK that they're arrays. A client could
    write a JSON object and break downstream `.length` reads.
  - `escalated_by` should be a FK to `auth.users` (or at minimum
    `profiles`).
  - `latency_ms`, `input_tokens`, `output_tokens`, `cache_*_tokens`
    accept negative values.
  - `cost_usd numeric(10,6)` accepts negatives.
  - No ON DELETE cascade from `companies`; tenant teardown blocks.
- **Worst consequence:** the patient-safety-critical row in the
  product has zero column-level guards beyond `status`. An adapter
  bug (or a hostile API-key holder per §1.1 in the validation audit)
  can write rows with `urgency_original='ROUTINE'` (uppercase),
  `clinical_routing_level='none'`, and `ai_confidence=1.5` — passing
  every server-side filter and rendering as a "low priority,
  high-confidence" message that staff dismiss. The only schema-level
  defense against this is the missing CHECK constraints.

### 1.6 `public.review_requests`
- **Source:** [0001_baseline.sql:94](migrations/0001_baseline.sql:94);
  `created_by` reconciled in [0009_review_requests_created_by.sql:35](migrations/0009_review_requests_created_by.sql:35).
- **Columns:** `id`, `company_id`, `triage_id`, `created_by`,
  `question NOT NULL`, `context`, `confidence`, `patient_message`,
  `ai_draft`, `status`, `answer`, `applied_to`, `resolved_by`,
  `resolved_by_name`, `resolved_at`, `created_at`.
- **NOT NULL:** `id`, `question`.
- **CHECK:** none.
- **UNIQUE:** `id` (PK).
- **Foreign keys:** `company_id → companies(id)` (no ON DELETE);
  `triage_id → query_history(id)` (no ON DELETE). `created_by`,
  `resolved_by` are bare uuids, no FK.
- **RLS:** enabled, no policies.
- **Gaps:**
  - `triage_id` is **nullable** and lacks ON DELETE CASCADE. The code
    in [history.js delete_entry](netlify/functions/_lib/routes/history.js:339)
    manually deletes child reviews before the parent
    (the comment there even calls out the missing cascade as a `23503`
    risk). If anyone ever deletes a `query_history` row outside that
    path (Supabase Dashboard, SQL editor, a future feature), the
    children orphan or the delete fails.
  - `status` no CHECK — should be `('pending','resolved','dismissed')`.
  - `applied_to` no CHECK — three-state model
    `('kb','kb_failed','confirmation')` is enforced only in code
    ([reviews.js:223–238](netlify/functions/_lib/routes/reviews.js:223)).
  - `context` no CHECK — should be `('routing','severity','category',
    'kb_gap','protocol','general')`; `kb_gap` and `protocol` drive KB
    promotion.
  - `confidence numeric(3,2)` no range CHECK in `[0,1]`.
  - `company_id` should be NOT NULL.
  - No UNIQUE on `(triage_id, context)` or even on `triage_id` alone —
    a single triage can spawn arbitrarily many review rows.
- **Worst consequence:** orphan rows survive a triage deletion if the
  delete path isn't `delete_entry`. Aggregations on `status`/`applied_to`
  drift silently on typoed values. A bad `context` value could route a
  resolve through neither the promote-to-KB nor the
  confirmation-only branch — falling through to `applied_to=
  'confirmation'` by default (this is the codebase's actual fallback
  in [reviews.js:223](netlify/functions/_lib/routes/reviews.js:223)).

### 1.7 `public.api_keys`
- **Source:** [0001_baseline.sql:116](migrations/0001_baseline.sql:116)
- **Columns:** `id`, `company_id NOT NULL`, `name`, `key_hash NOT NULL
  UNIQUE`, `last_used`, `created_at`.
- **NOT NULL:** `id`, `company_id`, `key_hash`.
- **CHECK:** none.
- **UNIQUE:** `id`, `key_hash`.
- **Foreign keys:** `company_id → companies(id)` (no ON DELETE).
- **RLS:** enabled, no policies.
- **Gaps:**
  - `key_hash` length not constrained — sha256 should be 64 hex chars.
    Trivial.
  - No `expires_at` / `revoked_at` column. Rotation requires deleting
    the row.
  - No FK protection on `company_id` delete: deleting a tenant fails.
- **Worst consequence:** the row that grants ingest access has no
  expiry mechanism. The only "revoke" is `DELETE`, which is
  irreversible if you wanted to grace-period the key.

### 1.8 `public.tenants`
- **Source:** [0002_tenants.sql:6](migrations/0002_tenants.sql:6)
- **Columns:** `id`, `company_id NOT NULL UNIQUE`, `brand_name NOT
  NULL`, `brand_tag`, `primary_color default '#2563eb'`,
  `default_response_style`, `allowed_categories jsonb default '[]'`,
  `escalation_thresholds jsonb default '{}'`, `is_active`,
  `trial_ends_at`, `created_at`, `updated_at`.
- **NOT NULL:** `id`, `company_id`, `brand_name`.
- **CHECK:** none.
- **UNIQUE:** `id`, `company_id`.
- **Foreign keys:** `company_id → companies(id) ON DELETE CASCADE`.
- **RLS:** enabled, no policies.
- **Gaps:**
  - `primary_color` no format CHECK (should be `^#[0-9A-Fa-f]{6}$`). A
    bad value flows into the brand UI's inline style; `esc()` doesn't
    cover CSS-injection vectors there.
  - `allowed_categories`, `escalation_thresholds` are `jsonb` with no
    schema enforcement. A malformed object surfaces as a runtime error
    on the client read.
  - `updated_at` is defaulted but no trigger keeps it fresh.
- **Worst consequence:** CSS injection via `primary_color` if the
  frontend ever uses it inside an inline style without sanitization.

### 1.9 `public.audit_log`
- **Source:** [0003_audit_log.sql:6](migrations/0003_audit_log.sql:6)
- **Columns:** `id`, `company_id`, `actor_id`, `actor_name`,
  `event_type NOT NULL`, `entity_type`, `entity_id`,
  `payload jsonb default '{}'`, `created_at`.
- **NOT NULL:** `id`, `event_type`.
- **CHECK:** none.
- **UNIQUE:** `id` (PK).
- **Foreign keys:** `company_id → companies(id)` (no ON DELETE).
  `actor_id`, `entity_id` are bare uuids (intentional — polymorphic
  `entity_type`).
- **RLS:** enabled, no policies.
- **Gaps:**
  - `company_id` nullable — system-level events without a tenant are
    valid, but most events should carry one. No CHECK that "if
    `actor_id is not null` then `company_id is not null`".
  - `event_type` is free-form despite the codebase's small known set
    (`kb.replace`, `review.resolve`, `triage.skip_stub`,
    `auth.first_admin_bootstrap`). Typos accumulate forever in an
    append-only table.
  - No UPDATE / DELETE restrictions at the schema level. RLS-default-
    deny prevents user-JWT writes, but the service key (used by every
    route) can rewrite or delete log rows. There's no
    "INSERT-only via trigger" guard.
- **Worst consequence:** log rows can be silently mutated or deleted
  by anyone with the service key (i.e. the application itself can
  cover its tracks via a bug or an explicit code change). For an
  audit log this is a substantive integrity gap.

### 1.10 `public.category_metadata`
- **Source:** [0010_roles_admin_categories.sql:91](migrations/0010_roles_admin_categories.sql:91)
- **Columns:** `id`, `company_id NOT NULL`, `category_name NOT NULL`,
  `is_clinical NOT NULL default true`, `display_order default 100`,
  `is_active default true`, `created_at`, `updated_at`.
- **NOT NULL:** `id`, `company_id`, `category_name`, `is_clinical`.
- **CHECK:** none.
- **UNIQUE:** `id`, `(company_id, category_name)`.
- **Foreign keys:** `company_id → companies(id) ON DELETE CASCADE`.
- **RLS:** enabled, no policies.
- **Gaps:**
  - `display_order` accepts negatives and very large values.
  - `category_name` no length cap. The admin handler doesn't cap
    either ([admin.js:203](netlify/functions/_lib/routes/admin.js:203)).
  - No CHECK that `category_name` is non-empty (`''` would pass NOT
    NULL).
  - No `updated_at` trigger.
- **Worst consequence:** an empty-string category name is allowed and
  would render as a blank pill in the picker.

---

## 2. RLS posture — the cross-cutting risk

Every table audited has `enable row level security` set. None has any
policy declared. The behavior under PostgreSQL is:

- **Service key** (`SUPABASE_SERVICE_KEY`) — bypasses RLS. Used by
  every Netlify function. Tenant isolation is enforced by `company_id`
  filters in the route handlers themselves.
- **Anon key** (`SUPABASE_ANON_KEY`) — subject to RLS. With no
  policies → 0 rows on SELECT, 0 rows affected on INSERT/UPDATE/DELETE.
  This is why `auth.js` switched to the service key for profile
  resolution (see [auth.js:38–60](netlify/functions/_lib/auth.js:38)).
- **User JWT** — same as anon: 0 rows.

This produces three concrete risks:

1. **Single-line tenant compromise.** A future `CREATE POLICY ...
   USING (true)` — easy to add via the Supabase Dashboard for "let
   me debug" — instantly grants every authenticated user every other
   tenant's data on whatever table it lands on. There is no second
   layer of defense; `company_id` filtering only happens because
   server code chooses to do it.

2. **The application is the only enforcer.** Every read path in the
   codebase must include a `company_id=eq.<callers>` clause. The
   route modules are consistent about this today, but the risk is
   that any new route (or any new query in an existing route) that
   forgets the filter returns data across tenants. There's no
   schema-level safety net.

3. **Audit-log mutability.** Because the service key bypasses RLS
   and the schema doesn't restrict UPDATE/DELETE on `audit_log`, the
   "append-only event log" promise in the migration's header comment
   is enforced only by convention.

A defensible posture would be either:

- Declare `FOR ALL USING (false)` explicit-deny policies on every
  table for the user role (turning the implicit deny into an explicit
  one, harder to accidentally relax); **and** add `INSERT-only`
  trigger-based protection on `audit_log`.
- OR write per-tenant `USING (company_id = current_setting(
  'request.jwt.claims', true)::json->>'company_id')` style policies
  so the user JWT can be trusted to read its own tenant's data
  directly — replacing the service-key bypass.

Neither approach exists today.

---

## 3. Ranked gaps

| Rank | Table | Gap | Why it matters |
|---|---|---|---|
| **HIGH** | all tenant tables | **No RLS policies declared.** | The whole tenant-isolation story is "the server's route handlers add a `company_id` filter." A single permissive policy added later — or a single forgotten filter in a new route — opens cross-tenant reads. No schema-level second line of defense. |
| **HIGH** | `query_history` | **No CHECK on `urgency_original`, `urgency_override`, `clinical_routing_level`, `clinical_category`, `source_channel`.** | The patient-safety enum fields the UI and aggregations consume are unconstrained free text. A typo or a hostile ingest writes `urgency='routine'` for a clinically severe message; nothing at the schema layer catches it. The application's allowlist (`URGENCY_OVERRIDE_VALUES`) gates one PATCH path, not inserts. |
| **HIGH** | `query_history` | `patient_message`, `user_id`, `company_id` **nullable**. | The "what the patient said" column is not NOT NULL. NULL rows would skip the triage logic that gates on `patient_message.trim()` in code. `company_id` NULL means the row escapes tenant aggregations; 0008 backfilled but the column is still allowed to be NULL on new inserts. |
| **HIGH** | `review_requests` | `triage_id` nullable + **no ON DELETE CASCADE** to `query_history`. | Code path in [history.js delete_entry](netlify/functions/_lib/routes/history.js:339) manually deletes reviews first, but any other delete path (Supabase Dashboard, future feature, SQL fix) either fails with 23503 or orphans the children. |
| **HIGH** | `audit_log` | **No INSERT-only enforcement.** | Service-key callers can UPDATE/DELETE rows. The "append-only" guarantee in the header comment is convention, not schema. |
| MEDIUM | `query_history` | `ai_confidence numeric(3,2)` no range CHECK in `[0,1]`. | Review-threshold logic (`< 0.75`) silently shifts behavior if the model drifts to a different scale. |
| MEDIUM | `review_requests` | No CHECK on `status`, `context`, `applied_to`; `company_id` nullable. | Status drift accumulates; the resolve fallthrough silently writes `applied_to='confirmation'` on unrecognized contexts. |
| MEDIUM | `profiles` | `role` nullable, no CHECK. `company_id` nullable. | `role` propagates from user-typed signup metadata. Permissions code treats unknown values as non-clinical (safe direction by accident). |
| MEDIUM | many | `user_id`/`actor_id`/`created_by`/`resolved_by`/`escalated_by` are **bare uuids, no FK**. | A deleted `auth.users` row leaves dangling references everywhere outside `profiles`. No referential integrity for audit lookups. |
| MEDIUM | `companies` & children | Most child FKs are NO ACTION on delete. | Tenant teardown can't be a single DELETE; risk of partial deletes leaving orphans. |
| MEDIUM | `query_history` | Numeric columns (`latency_ms`, `*_tokens`, `cost_usd`) accept negatives. | Aggregations on negative values look reasonable in isolation but distort sums and averages. |
| LOW | `kb_entries` | No UNIQUE on `(company_id, section, position)`; `section` no CHECK. | Duplicate positions cause non-deterministic render order. Typo'd `section` silently disappears from the prompt builder. |
| LOW | `company_members` | Redundant source of `role` truth versus `profiles.role`. | No reader today; risk is if a future code path picks the wrong source. |
| LOW | `tenants` | `primary_color` no format CHECK. | Potential CSS injection vector if the value is ever rendered into an inline style without sanitization. |
| LOW | `api_keys` | No expiry/revocation columns; `key_hash` length not constrained. | Rotation requires DELETE. SHA256 length check is cosmetic. |
| LOW | `category_metadata` | `category_name` allows `''`; `display_order` allows negatives. | Blank pills in picker. |

---

## 4. Cross-cutting recommendations (for the human, not for me to apply)

Three patches would close most of the HIGH-rank gaps at the schema level:

1. **Add CHECK constraints on the `query_history` enum columns.** Mirror
   what the codebase already enumerates: `URGENCY_OVERRIDE_VALUES` for
   urgency, the `BASE_PROMPT_TEMPLATE` category set for
   `clinical_category`, `('severe','moderate','mild','none')` for
   `clinical_routing_level`, the channel id list for `source_channel`.
2. **Tighten `company_id` to NOT NULL** on `profiles`, `kb_entries`,
   `query_history`, `review_requests`, `audit_log` — gated behind a
   final 0008-style backfill check. Same for
   `query_history.patient_message`.
3. **Add ON DELETE CASCADE** from `review_requests.triage_id` to
   `query_history.id` (and tenant-cascades elsewhere), so the delete
   path doesn't have to know about child cleanup.
4. **Add an explicit RLS policy** (even `FOR ALL USING (false)` for the
   user role) so the deny is intentional rather than incidental, and
   so a permissive policy added later is visible diff against an
   explicit baseline.
5. **Restrict `audit_log` mutations** via a `BEFORE UPDATE OR DELETE`
   trigger that raises an exception, regardless of role.

No code or schema changes were made by this audit.
