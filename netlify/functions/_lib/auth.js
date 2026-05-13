// _lib/auth.js
//
// User verification and profile resolution. Extracted from kb.js
// (v0.4.0) so route handlers share a single source of truth for
// "who is the caller" and "what tenant + role + flags do they have."
//
// Three lookup tiers:
//   - verifyUser(token) — confirms the JWT against Supabase Auth.
//     Returns the auth user record (id, email, etc.) or null.
//     This is the cheapest check; most routes start with this.
//   - resolveCompanyId(user) — single-purpose lookup for the
//     tenant id. Used by the original tenant-scoped read paths
//     before role gates existed. Still here for callers that only
//     need company_id; cheaper than fetching the full profile.
//   - resolveProfile(user) — full profile (role + flags +
//     company_id) in one query. Used by every gated endpoint so
//     role checks happen against the persisted source of truth.
//
// All three swallow errors and return null on failure. Callers
// must check for null and translate to a 401 (verifyUser) or
// proceed defensively (resolveCompanyId/Profile — null company_id
// is a real state for legacy users).

const { SUPABASE_URL, readHeaders, writeHeaders } = require("./supabase");

async function verifyUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: readHeaders(token) });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    console.error("auth.verifyUser:", e.message);
    return null;
  }
}

// Look up the verified user's company_id from the profiles table
// using the service key. Returns null if no company_id is set on
// the row.
//
// This is the keystone for tenant-scoped reads. Read endpoints
// route through here so they can scope queries by company_id
// explicitly — independent of whatever RLS policies happen (or
// don't) to be configured on the tables. The migrations enable
// RLS on every tenant table but never declare any SELECT
// policies, which means user-JWT reads return zero rows by
// default. Service-key + explicit company_id filter is what
// makes the read path actually work and not depend on
// Supabase-dashboard configuration drift.
async function resolveCompanyId(user) {
  if (!user || !user.id) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=company_id`,
      { headers: writeHeaders() }
    );
    const profiles = await r.json();
    return Array.isArray(profiles) && profiles[0] ? profiles[0].company_id : null;
  } catch (e) {
    console.error("auth.resolveCompanyId:", e.message);
    return null;
  }
}

// Resolve the verified user's full profile (role + flags +
// company_id) in one query. Used by every gated endpoint so role
// checks happen against the persisted source of truth, not
// whatever the client claims.
//
// Returns: { id, full_name, company_id, role, is_admin,
// is_super_user } or null. Role values match production data:
// 'Clinical' | 'Non-Clinical' (also tolerates the legacy 'staff'
// default = no clinical authorization per permissions.js).
async function resolveProfile(user) {
  if (!user || !user.id) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=id,company_id,role,is_admin,is_super_user,full_name`,
      { headers: writeHeaders() }
    );
    const profiles = await r.json();
    return Array.isArray(profiles) && profiles[0] ? profiles[0] : null;
  } catch (e) {
    console.error("auth.resolveProfile:", e.message);
    return null;
  }
}

// Convenience: extract the bearer token from a Netlify event's
// Authorization header. Every route in this codebase needs this
// dance; centralize it.
function extractToken(event) {
  return (event.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

// First-admin bootstrap (v0.4.2). When a user signs in and there
// are zero super-users in their tenant, auto-promote them to
// is_admin=true + is_super_user=true. One-time event per tenant.
//
// Why: the v0.3.27 setup required running migration 0010 AND a
// manual UPDATE to elevate the first user. The migration is
// reasonable (DB schema change); the UPDATE is a manual step
// that's easy to forget — and easy to confuse with the migration
// itself. (See v0.4.1 changelog where Brad asked "I thought I'd
// be the admin/super user?" after running just the migration.)
// Bootstrap eliminates the manual UPDATE for every future tenant.
//
// Safety:
//   - Only fires when ZERO super-users exist in the tenant. If
//     anyone is already super-user, bootstrap does nothing — so
//     a later admin demoting themselves CAN'T trigger
//     re-promotion of an arbitrary user.
//   - Requires a known company_id. If the caller has no
//     company_id resolved (unattached profile, no companies
//     row), bootstrap skips.
//   - Writes an audit_log entry so the promotion is visible
//     in the audit trail.
//   - Race: two users signing in at the same instant could BOTH
//     pass the "no super_user" check before either is promoted.
//     They'd both end up super-user. Acceptable — the worst
//     outcome is two legitimate first-time admins in a tenant
//     that genuinely had no admin, which is benign.
//
// Mutates the passed-in `profile` object in place (sets is_admin
// and is_super_user on it) so the caller's response reflects
// the new state without a re-fetch. Returns true if promoted,
// false if not.
async function maybeBootstrapFirstAdmin(user, profile, headers) {
  if (!user || !user.id) return false;
  if (!profile) return false;
  if (profile.is_super_user) return false;       // already super-user
  if (!profile.company_id) return false;          // no tenant scope
  try {
    // Check: are there any super-users in this tenant?
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?company_id=eq.${encodeURIComponent(profile.company_id)}&is_super_user=eq.true&select=id&limit=1`,
      { headers }
    );
    if (!checkRes.ok) {
      // If we can't check, fail closed — don't promote on a
      // failed lookup, that's the dangerous direction.
      console.error("auth.maybeBootstrapFirstAdmin.check:", checkRes.status);
      return false;
    }
    const existing = await checkRes.json();
    if (Array.isArray(existing) && existing.length > 0) return false;

    // No super-user in this tenant — promote.
    const promoteRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`,
      {
        method: "PATCH",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify({ is_admin: true, is_super_user: true }),
      }
    );
    if (!promoteRes.ok) {
      console.error("auth.maybeBootstrapFirstAdmin.promote:", promoteRes.status);
      return false;
    }

    // Mutate the in-memory profile so the response reflects the
    // new state without another round-trip.
    profile.is_admin = true;
    profile.is_super_user = true;

    // Audit log — best-effort, doesn't block the response.
    fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: "POST",
      headers: { ...headers, "Prefer": "return=minimal" },
      body: JSON.stringify({
        company_id: profile.company_id,
        actor_id: user.id,
        event_type: "auth.first_admin_bootstrap",
        entity_type: "profiles",
        entity_id: user.id,
        payload: { reason: "no_super_user_in_tenant" },
      }),
    }).catch(e => console.error("auth.maybeBootstrapFirstAdmin.audit:", e.message));

    console.log("auth.firstAdminBootstrap: promoted user", user.id, "in tenant", profile.company_id);
    return true;
  } catch (e) {
    console.error("auth.maybeBootstrapFirstAdmin:", e.message);
    return false;
  }
}

module.exports = {
  verifyUser,
  resolveCompanyId,
  resolveProfile,
  extractToken,
  maybeBootstrapFirstAdmin,
};
