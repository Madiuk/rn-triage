-- 0030_invite_auth.sql
--
-- Replaces the magic-link self-signup flow with super-user-issued
-- invites that land on /accept-invite.html where the invitee sets a
-- password. The auth surface in netlify/functions/auth.js is rewritten
-- in this same commit; this migration is the schema half.
--
-- ── Why this change ────────────────────────────────────────────────
--
-- Pre-launch we ran on Supabase Auth's OTP / magic-link flow with a
-- single-tenant trial dataset. Now that real patient data is flowing
-- (Intercom + Bask), the threat model has changed: a magic-link
-- email to a compromised inbox grants full access on a single click,
-- and self-signup makes account provenance opaque. Going forward,
-- accounts are created by super-users only; the invitee picks a
-- password before they can log in; magic link will be turned off at
-- the Supabase dashboard level once existing staff have set
-- passwords (separate one-shot reset-email script, run post-deploy).
--
-- ── Schema changes ─────────────────────────────────────────────────
--
--   * first_name / last_name : the existing `full_name` column is one
--     field and gets parsed for display in several places (avatar
--     initials, sort, etc.). The invite form collects first + last
--     separately because that's what humans actually fill in, and
--     splitting at write time is more reliable than splitting at read
--     time. Existing rows get a best-effort backfill (split on first
--     space) so the new column population path is uniform.
--
--   * prefix / suffix : honorifics that bracket the display name.
--     prefix is "Dr." / "Ms." / etc. (≤ 8 chars). suffix is the
--     credential ("RN", "MD", "NP", "Pharm.D.") that today lives in
--     `title`. We keep `title` for back-compat and read paths that
--     still reference it, and back-fill suffix from title so new
--     reads can switch over progressively.
--
--   * email : a snapshot of the invitee's email address. Snapshot
--     rather than join because the Staff admin view needs the
--     primary identifier on every row and the alternative (per-row
--     fetch against auth.users via the admin API) is N+1. Auth's
--     email remains authoritative for sign-in; this column is for
--     display + admin reference. If a user ever changes their email
--     via the Supabase dashboard the snapshot stales — accept that
--     risk for now, add a sync job if email changes become routine.
--
--   * invited_at / accepted_at : invite-state timestamps. The pair
--     gives us four meaningful states:
--       invited_at NOT NULL, accepted_at NULL     → pending invite
--       invited_at NOT NULL, accepted_at NOT NULL → accepted (active)
--       invited_at NULL,     accepted_at NOT NULL → legacy (self-served
--                                                   via magic link, or
--                                                   created in the
--                                                   Supabase dashboard)
--       invited_at NULL,     accepted_at NULL     → bug / orphan
--
--     The Staff admin view filters on `accepted_at IS NULL` to
--     surface pending invites; the same predicate gates UI elements
--     that should not be shown to an account that never finished
--     onboarding.
--
-- ── No DB CHECK on prefix / suffix ─────────────────────────────────
--
-- Length is bounded at the application layer (auth.js) — prefix ≤ 8,
-- suffix ≤ 24 — matching the established precedent set by `title` in
-- migration 0017. Adding a CHECK would force a migration every time
-- the limit needs a nudge (e.g. "Hon. Justice" would blow 8 chars),
-- and we don't anticipate enough churn at the DB layer to justify
-- the cost. Same rationale as title.
--
-- ── Backfill semantics ─────────────────────────────────────────────
--
--   * first_name / last_name : split full_name on first space. Single-
--     token names go entirely into first_name; last_name stays NULL.
--     A future admin UI lets staff correct their own names.
--
--   * suffix : copy from `title`. title stays populated; suffix is
--     the new canonical column.
--
--   * accepted_at : set to created_at for every existing row. Every
--     pre-invite-flow row got into the DB via magic-link sign-in,
--     which we treat as implicit acceptance. Without this back-fill
--     existing staff would appear as "pending invites" in the new
--     Staff admin view.
--
--   * invited_at : not back-filled. Pre-existing rows weren't
--     invited via this flow; NULL is the correct semantic value.
--
--   * email : copied from auth.users.email on the join `profiles.id
--     = auth.users.id`. The migration runs with elevated grants so
--     reading auth.users is allowed.
--
-- Idempotent. Safe to re-run.

-- 1. New name + honorific columns.
alter table public.profiles
  add column if not exists first_name text;

alter table public.profiles
  add column if not exists last_name text;

alter table public.profiles
  add column if not exists prefix text;

alter table public.profiles
  add column if not exists suffix text;

alter table public.profiles
  add column if not exists email text;

-- 2. Invite-state timestamps.
alter table public.profiles
  add column if not exists invited_at timestamptz;

alter table public.profiles
  add column if not exists accepted_at timestamptz;

-- 3. Back-fill first_name / last_name from full_name.
--    split_part(name, ' ', 1) is the first token; trim of the rest
--    is everything after the first space. Single-token names give
--    an empty rest-string which we explicitly convert to NULL.
update public.profiles
   set first_name = split_part(full_name, ' ', 1)
 where first_name is null
   and full_name is not null
   and full_name <> '';

update public.profiles
   set last_name = nullif(trim(substring(full_name from position(' ' in full_name) + 1)), '')
 where last_name is null
   and full_name is not null
   and position(' ' in full_name) > 0;

-- 4. Back-fill suffix from title.
update public.profiles
   set suffix = title
 where suffix is null
   and title is not null
   and title <> '';

-- 5. Mark every existing profile as accepted.
update public.profiles
   set accepted_at = created_at
 where accepted_at is null;

-- 6. Snapshot the auth-side email onto every existing profile.
update public.profiles p
   set email = u.email
  from auth.users u
 where p.id = u.id
   and p.email is null;
