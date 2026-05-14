-- 0017_staff_title_and_role_snapshots.sql
-- Decouples the user-facing credential ("RN", "MD", "NP", "CSR")
-- from the permission enum (`role`), and lays the foundation for
-- future per-role learning segmentation by snapshotting the
-- editing staff's role and title onto every learning-signal row.
--
-- ── Why this change ────────────────────────────────────────────────
--
-- Before: `role` was both the permission axis and the display label.
-- The UI hardcoded "Clinical Staff (RN)" for every Clinical user,
-- which lies the moment a doctor signs in.
--
-- After: `title` is the display credential, free text. `role` stays
-- the permission axis (Clinical | Non-Clinical | staff). They evolve
-- independently — a doctor is `role='Clinical', title='MD'`, an NP
-- is `'NP'`, future tenants in other verticals fill in whatever
-- credential matters to them ("Licensed Mechanic", "Property Mgr",
-- etc.).
--
-- Snapshot columns on query_history and review_requests capture
-- WHO edited (by role and title) at write time, even if that user's
-- role/title later changes. We don't read these columns yet — they
-- just lay the rail for the per-role learning segmentation that
-- PLAN.md Phase 3/5 will eventually need. Today the analytics
-- pool stays undifferentiated; nothing in this migration changes
-- what staff see or how the AI behaves.
--
-- ── Why no DB CHECK on title ───────────────────────────────────────
--
-- title is intentionally free text. Adding a CHECK would force a
-- migration every time a tenant introduces a new credential
-- ("LCSW", "MA", "Pharm.D.", "Cert. Mech."), defeating the point
-- of decoupling display from the permission enum. Length is
-- bounded at the application layer (≤24 chars, trimmed) in
-- auth.js and admin.js. profiles.role similarly has no DB CHECK
-- (the allowlist lives in code), so this stays consistent.
--
-- ── Backfill semantics ─────────────────────────────────────────────
--
-- profiles.title is backfilled: 'RN' for existing Clinical, 'CSR'
-- for existing Non-Clinical. Safe for our single tenant where no
-- MDs are trialing the software yet (confirmed in chat
-- 2026-05-13). New invites can override with any title.
--
-- query_history.{user_role,user_title} and review_requests.
-- {resolved_by_role,resolved_by_title} are NOT backfilled. The
-- absence of role/title on pre-snapshot rows IS meaningful — those
-- rows were written before we tracked this. Future role-aware
-- analytics will need to treat NULL as "pre-snapshot, exclude
-- from segmented pools."
--
-- Idempotent. Safe to re-run.

-- 1. Per-staff display credential.
alter table public.profiles
  add column if not exists title text;

update public.profiles
   set title = 'RN'
 where role = 'Clinical'
   and title is null;

update public.profiles
   set title = 'CSR'
 where role = 'Non-Clinical'
   and title is null;

-- 2. Snapshot the editing staff's role + title onto each triage row.
--    Written by /history POST (default insert branch) from the
--    server-verified callerProfile, never from the client body —
--    same hardening pattern as `user_id` and `company_id`.
alter table public.query_history
  add column if not exists user_role  text;

alter table public.query_history
  add column if not exists user_title text;

-- 3. Same snapshot for review-request resolutions. Matches the
--    naming pattern established by migration 0009's
--    `resolved_by_name` snapshot column.
alter table public.review_requests
  add column if not exists resolved_by_role  text;

alter table public.review_requests
  add column if not exists resolved_by_title text;
