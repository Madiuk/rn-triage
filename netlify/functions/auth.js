// Care Station — Auth & Profile Netlify Function
// Endpoints: GET /auth/profile, POST /auth/invite, POST /auth/signout

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// First-admin bootstrap helper. Lives in _lib so the kb.js router
// can share it later if needed; for now only /auth/profile calls it.
// See _lib/auth.js for the rationale (closes the manual UPDATE
// step that bit v0.4.1 — a fresh tenant has no super-user until
// someone runs SQL; bootstrap eliminates that step).
const { maybeBootstrapFirstAdmin } = require('./_lib/auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  const path = event.path || '';
  const method = event.httpMethod;

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();

  const userH = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + (token || SUPABASE_ANON_KEY)
  };

  const serviceH = SUPABASE_SERVICE_KEY ? {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  } : null;

  try {

    // ── GET /auth/profile ─────────────────────────────────────────────────
    if (path.includes('/profile') && method === 'GET') {
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };

      // Validate token — get user from Supabase Auth
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const user = await userRes.json();
      if (!user || !user.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }

      // Get profile — simple query, no joins (joins fail if company_members row missing)
      const hdr = serviceH || userH;
      let profile = null;
      try {
        const profRes = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=id,full_name,role,title,company_id,triages_completed,last_seen,is_admin,is_super_user`,
          { headers: hdr }
        );
        const profiles = await profRes.json();
        profile = Array.isArray(profiles) && profiles.length > 0 ? profiles[0] : null;
      } catch(e) { console.error('auth.fetchProfile:', e.message); }

      // If no profile row exists yet, create one from user metadata.
      //
      // company_id auto-attach: when there's exactly ONE company in
      // the DB (single-tenant trial), attach the new user to it.
      // Otherwise (multi-tenant), require explicit invitation via
      // /auth/invite — leave company_id null and let an admin sort
      // it out. Without this, users created via the Supabase
      // dashboard (bypassing /auth/invite) would get permanent
      // company_id=null profiles. Their triages would then have
      // company_id=null (frontend's getCompanyId reads from this),
      // making them invisible to company-scoped aggregations and
      // breaking learning-loop feedback for those users.
      if (!profile) {
        try {
          const name = (user.user_metadata && user.user_metadata.full_name)
            || user.email.split('@')[0];
          const role = (user.user_metadata && user.user_metadata.department) || 'staff';

          let defaultCompanyId = null;
          try {
            const compsRes = await fetch(
              `${SUPABASE_URL}/rest/v1/companies?select=id&limit=2`,
              { headers: hdr }
            );
            const comps = await compsRes.json();
            if (Array.isArray(comps) && comps.length === 1) {
              defaultCompanyId = comps[0].id;
            }
          } catch(e) { console.error('auth.lookupDefaultCompany:', e.message); }

          const newProfile = { id: user.id, full_name: name, role: role };
          if (defaultCompanyId) newProfile.company_id = defaultCompanyId;

          const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: 'POST',
            headers: { ...(hdr), 'Prefer': 'return=representation' },
            body: JSON.stringify(newProfile)
          });
          const inserted = await insertRes.json();
          profile = Array.isArray(inserted) ? inserted[0] : inserted;
        } catch(e) { console.error('auth.createProfile:', e.message); }
      }

      // Bootstrap the first admin in the tenant if none exists yet.
      // This is the missing step from migration 0010 — without it,
      // a fresh tenant has no super-user and the admin/settings/
      // categories endpoints (super_user_only) are unreachable. The
      // helper is a no-op when any super-user already exists, when
      // the profile has no company_id, or when the lookup fails
      // (fails closed). Mutates `profile` in place on success so
      // the response below reflects the new flags without re-fetch.
      // Internally try/catch-wrapped — won't throw out to here.
      if (profile) {
        await maybeBootstrapFirstAdmin(user, profile, hdr);
      }

      // Update last_seen silently
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          headers: { ...hdr, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_seen: new Date().toISOString() })
        });
      } catch(e) { console.error('auth.updateLastSeen:', e.message); }

      // Get company name + tenant config in parallel if company_id exists.
      // Both are best-effort — if either is missing the client falls back
      // to RELAI_DEFAULTS in data/defaults.js so single-tenant deployments
      // continue to work without a tenants row.
      let companyName = null;
      let tenantConfig = null;
      if (profile && profile.company_id) {
        try {
          const [compRes, tenRes] = await Promise.all([
            fetch(`${SUPABASE_URL}/rest/v1/companies?id=eq.${profile.company_id}&select=name`, { headers: hdr }),
            fetch(`${SUPABASE_URL}/rest/v1/tenants?company_id=eq.${profile.company_id}&select=*`, { headers: hdr })
          ]);
          const companies = await compRes.json();
          if (Array.isArray(companies) && companies[0]) companyName = companies[0].name;
          const tenants = await tenRes.json();
          if (Array.isArray(tenants) && tenants[0]) {
            const t = tenants[0];
            tenantConfig = {
              brand: { name: t.brand_name, tag: t.brand_tag, primaryColor: t.primary_color },
              defaultResponseStyle: t.default_response_style || null,
              allowedCategories: t.allowed_categories || [],
              escalationThresholds: t.escalation_thresholds || {}
            };
          }
        } catch(e) { console.error('auth.fetchTenant:', e.message); }
      }

      if (profile) {
        if (companyName) profile.company_name = companyName;
        if (tenantConfig) profile.tenant = tenantConfig;
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ user, profile })
      };
    }

    // ── POST /auth/invite ─────────────────────────────────────────────────
    //
    // Earlier this endpoint had NO caller auth at all — anyone with the
    // URL could POST { email, company_id, role: 'Clinical', is_admin:
    // true } and create a confirmed Supabase user attached to any
    // tenant with any role. That's full tenant takeover with one curl.
    // RELAI_VALIDATION_AUDIT.md flagged it as the highest-severity
    // finding in the function set.
    //
    // The gates added below, in order:
    //   1. Bearer token required + verified against Supabase Auth.
    //   2. Caller's profile lookup; is_admin = true required.
    //   3. Caller must have a resolved company_id (no orphan admins
    //      inviting into nothing).
    //   4. Body key allowlist — refuses unknown fields like
    //      is_admin / is_super_user that a future caller might try
    //      to slip through. Today's defense against tomorrow's
    //      privilege-escalation refactor.
    //   5. role allowlist — Clinical | Non-Clinical | staff.
    //   6. company_id forced to caller's tenant. If body sends a
    //      different company_id, refuse explicitly (cross-tenant
    //      invite) rather than silently overriding.
    //
    // Side effects (admin/users create, profile PATCH, company_members
    // insert) do NOT run until every gate above has passed.
    if (path.includes('/invite') && method === 'POST') {
      if (!serviceH) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not configured' }) };

      // 1. Bearer token + Supabase Auth verification.
      if (!token) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentication required.' }) };
      }
      const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const caller = await callerRes.json();
      if (!caller || !caller.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }

      // 2. Profile lookup → admin gate. Service key + explicit id
      //    filter so we don't depend on RLS configuration. Missing
      //    profile is treated as non-admin (fail closed).
      const callerProfRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${caller.id}&select=is_admin,is_super_user,company_id`,
        { headers: serviceH }
      );
      const callerProfiles = await callerProfRes.json();
      const callerProfile = Array.isArray(callerProfiles) && callerProfiles[0] ? callerProfiles[0] : null;
      if (!callerProfile || !callerProfile.is_admin) {
        return {
          statusCode: 403,
          headers: CORS,
          body: JSON.stringify({ error: 'Admin access required.', code: 'admin_only' }),
        };
      }

      // 3. Caller must have a tenant. Without one we can't determine
      //    where the invite lands, and forcing a fallback would let
      //    an unattached admin invite into arbitrary tenants.
      const callerCompanyId = callerProfile.company_id;
      if (!callerCompanyId) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: 'Caller has no company_id; cannot invite into a tenant.' }),
        };
      }

      // 4. Parse body with explicit error path (not the outer catch's
      //    500). Enforce key allowlist defensively.
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch (e) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
      }
      const ALLOWED_BODY_KEYS = new Set(['email', 'role', 'company_id', 'title']);
      for (const k of Object.keys(body)) {
        if (!ALLOWED_BODY_KEYS.has(k)) {
          return {
            statusCode: 400,
            headers: CORS,
            body: JSON.stringify({ error: 'Unexpected body key: ' + k }),
          };
        }
      }
      const { email } = body;
      if (!email) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email required' }) };
      }

      // 5. role allowlist. 'staff' is preserved as the legacy default
      //    (profiles.role still accepts it per 0001_baseline) so this
      //    gate is non-breaking for legitimate admin callers.
      const role = body.role || 'staff';
      const ALLOWED_ROLES = new Set(['Clinical', 'Non-Clinical', 'staff']);
      if (!ALLOWED_ROLES.has(role)) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: "role must be 'Clinical', 'Non-Clinical', or 'staff'." }),
        };
      }

      // 5b. title — optional free-text credential (migration 0017).
      //     Length-bounded at the app layer (no DB CHECK; see
      //     migration comment). Trim whitespace; reject if >24
      //     chars after trim. Null/undefined are fine — the
      //     migration backfills 'RN'/'CSR' on the profile PATCH
      //     callsite below only if no title was provided.
      let title = null;
      if ('title' in body && body.title != null) {
        if (typeof body.title !== 'string') {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'title must be a string.' }) };
        }
        title = body.title.trim();
        if (title.length > 24) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'title must be 24 characters or fewer.' }) };
        }
        if (title.length === 0) title = null;
      }

      // 6. Tenant is the CALLER's. If body included a different
      //    company_id, refuse explicitly — silent override would
      //    mask the caller's intent to do something they aren't
      //    allowed to do.
      if ('company_id' in body && body.company_id && body.company_id !== callerCompanyId) {
        return {
          statusCode: 403,
          headers: CORS,
          body: JSON.stringify({ error: 'Cross-tenant invite refused. You may only invite into your own tenant.', code: 'cross_tenant' }),
        };
      }
      const company_id = callerCompanyId;

      // Side effects start here. All three writes use the service
      // key — admin/users requires it; profiles + company_members do
      // too because RLS denies user-JWT writes.
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: serviceH,
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { role, company_id } })
      });
      const newUser = await r.json();
      if (!newUser.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: newUser.message || 'Failed to create user' }) };
      }

      const profilePatch = { role, company_id };
      if (title != null) profilePatch.title = title;
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${newUser.id}`, {
        method: 'PATCH',
        headers: { ...serviceH, 'Prefer': 'return=minimal' },
        body: JSON.stringify(profilePatch)
      });

      // company_id is guaranteed non-null by the earlier gate, so the
      // original `if (company_id)` wrapper around this insert is no
      // longer needed.
      await fetch(`${SUPABASE_URL}/rest/v1/company_members`, {
        method: 'POST',
        headers: { ...serviceH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ company_id, user_id: newUser.id, role })
      });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, user_id: newUser.id, email }) };
    }

    // ── POST /auth/signout ────────────────────────────────────────────────
    if (path.includes('/signout') && method === 'POST') {
      if (token) {
        try {
          const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
          const user = await userRes.json();
          if (user && user.id) {
            const hdr = serviceH || userH;
            await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
              method: 'PATCH',
              headers: { ...hdr, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ last_seen: new Date().toISOString() })
            });
          }
        } catch(e) { console.error('auth.signoutTouch:', e.message); }
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };

  } catch(err) {
    console.error('auth.handler:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
