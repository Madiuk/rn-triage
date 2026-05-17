// Care Station — Auth & Profile Netlify Function
// Endpoints:
//   GET  /auth/profile        — caller's profile (creates row on first hit)
//   POST /auth/invite         — super-user invites a new staff member (sends email)
//   POST /auth/accept         — invitee marks themselves accepted after setting password
//   POST /auth/resend-invite  — super-user re-sends an invite to a pending invitee
//   GET  /auth/staff          — super-user lists tenant staff
//   POST /auth/signout        — touch last_seen on sign-out

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

    // ── POST /auth/resend-invite ─────────────────────────────────────────
    //
    // Super-user resends an invite to a pending invitee. Uses Supabase's
    // /auth/v1/recover endpoint server-side, which triggers an email
    // containing a password-set link. The link lands at the same
    // /accept-invite.html page the original invite used, so the
    // invitee's flow is unchanged. The email's subject says "Reset
    // password" rather than "You've been invited" — known UX wart,
    // good enough until a transactional email provider lets us send
    // our own invite-themed re-sends.
    //
    // Gates (in order, no side effect until all pass):
    //   1. Bearer token + super-user gate (same as /auth/invite).
    //   2. Body allowlist — only user_id accepted (email is read from
    //      the profile server-side, never trusted from the body).
    //   3. Target must be in caller's tenant.
    //   4. Target must not have accepted yet (accepted_at IS NULL).
    //      Re-sending to an active user would surprise them and could
    //      be a phishing-priming vector.
    //
    // IMPORTANT — placement: this block must come BEFORE /auth/invite
    // in source order because path.includes('/invite') would
    // otherwise match /auth/resend-invite first.
    if (path.includes('/resend-invite') && method === 'POST') {
      if (!serviceH) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not configured' }) };
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentication required.' }) };

      const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const caller = await callerRes.json();
      if (!caller || !caller.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }
      const callerProfRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${caller.id}&select=is_super_user,company_id`,
        { headers: serviceH }
      );
      const callerProfiles = await callerProfRes.json();
      const callerProfile = Array.isArray(callerProfiles) && callerProfiles[0] ? callerProfiles[0] : null;
      if (!callerProfile || !callerProfile.is_super_user) {
        return {
          statusCode: 403,
          headers: CORS,
          body: JSON.stringify({ error: 'Super-user access required.', code: 'super_user_only' }),
        };
      }
      if (!callerProfile.company_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Caller has no company_id.' }) };
      }

      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch (e) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
      }
      const ALLOWED = new Set(['user_id']);
      for (const k of Object.keys(body)) {
        if (!ALLOWED.has(k)) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unexpected body key: ' + k }) };
        }
      }
      const user_id = body.user_id;
      if (!user_id || typeof user_id !== 'string') {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'user_id required.' }) };
      }

      // Tenant + pending-state check.
      const targetRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}` +
        `&company_id=eq.${encodeURIComponent(callerProfile.company_id)}` +
        `&select=id,email,accepted_at`,
        { headers: serviceH }
      );
      const targets = await targetRes.json();
      const target = Array.isArray(targets) && targets[0] ? targets[0] : null;
      if (!target) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'User not found in your tenant.' }) };
      }
      if (target.accepted_at) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'User has already accepted their invite.', code: 'already_accepted' }) };
      }
      if (!target.email) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'User has no email on file.' }) };
      }

      // Trigger Supabase password-recovery email. Uses the anon key
      // because /auth/v1/recover is the public reset-password
      // endpoint (anyone-can-call); we've already gated the
      // resend-invite action itself above.
      //
      // redirect_to is passed as a URL query string param. Some
      // gotrue versions ignore body-level redirect_to and fall back
      // to the dashboard Site URL — that's the bug that landed
      // reset emails at `/` instead of /accept-invite.html for Brad
      // 2026-05-17. Belt-and-braces: pass it both ways.
      const redirectUrl = process.env.INVITE_REDIRECT_URL
        || (process.env.URL ? process.env.URL.replace(/\/$/, '') + '/accept-invite.html' : null);
      const recoverPayload = { email: target.email };
      if (redirectUrl) recoverPayload.redirect_to = redirectUrl;

      const recoverUrl = `${SUPABASE_URL}/auth/v1/recover`
        + (redirectUrl ? '?redirect_to=' + encodeURIComponent(redirectUrl) : '');
      const recoverRes = await fetch(recoverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(recoverPayload),
      });
      if (!recoverRes.ok) {
        let data = {};
        try { data = await recoverRes.json(); } catch (e) {}
        const msg = data.msg || data.message || data.error_description || data.error || 'Could not resend invite';
        return { statusCode: recoverRes.status || 500, headers: CORS, body: JSON.stringify({ error: msg }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, email: target.email }) };
    }

    // ── POST /auth/invite ─────────────────────────────────────────────────
    //
    // History: this endpoint had NO caller auth originally — full
    // tenant-takeover-with-one-curl (RELAI_VALIDATION_AUDIT.md). The
    // is_admin gate added next closed that hole. With magic-link sign-up
    // going away (real-patient-data threat model in mig 0030 comment),
    // this endpoint becomes the ONLY path to account creation, so the
    // gate tightens further to super-user.
    //
    // The gates below, in order — every side effect happens AFTER all
    // of them pass:
    //   1. Bearer token required + verified against Supabase Auth.
    //   2. Caller's profile lookup; is_super_user = true required.
    //   3. Caller must have a resolved company_id (no orphan supers
    //      inviting into nothing).
    //   4. Body key allowlist — refuses unknown fields like is_admin
    //      or is_super_user that a future caller might try to slip
    //      through. Today's defense against tomorrow's privilege-
    //      escalation refactor. company_id is also NOT accepted —
    //      tenant is server-derived from caller, never from body.
    //   5. Per-field validation: email shape, names 1–80 chars,
    //      role in {Clinical, Non-Clinical}, prefix ≤ 8 chars,
    //      suffix ≤ 24 chars (mirrors the title precedent from
    //      migration 0017 — no DB CHECK, app-layer bound).
    //
    // Then: call Supabase POST /auth/v1/invite (the admin invite
    // endpoint — generates an invite token + sends the email to the
    // invitee). Followed by an INSERT into profiles so the pending
    // invite is visible immediately in the Staff admin view, and a
    // company_members insert for the join-table back-compat.
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

      // 2. Profile lookup → super-user gate. Service key + explicit id
      //    filter so we don't depend on RLS configuration. Missing
      //    profile is treated as non-super-user (fail closed).
      const callerProfRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${caller.id}&select=is_super_user,company_id`,
        { headers: serviceH }
      );
      const callerProfiles = await callerProfRes.json();
      const callerProfile = Array.isArray(callerProfiles) && callerProfiles[0] ? callerProfiles[0] : null;
      if (!callerProfile || !callerProfile.is_super_user) {
        return {
          statusCode: 403,
          headers: CORS,
          body: JSON.stringify({ error: 'Super-user access required.', code: 'super_user_only' }),
        };
      }

      // 3. Caller must have a tenant.
      const company_id = callerProfile.company_id;
      if (!company_id) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: 'Caller has no company_id; cannot invite into a tenant.' }),
        };
      }

      // 4. Body parse + key allowlist.
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch (e) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
      }
      const ALLOWED_BODY_KEYS = new Set(['email', 'first_name', 'last_name', 'role', 'prefix', 'suffix']);
      for (const k of Object.keys(body)) {
        if (!ALLOWED_BODY_KEYS.has(k)) {
          return {
            statusCode: 400,
            headers: CORS,
            body: JSON.stringify({ error: 'Unexpected body key: ' + k }),
          };
        }
      }

      // 5. Per-field validation.
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!email || !email.includes('@') || !email.includes('.')) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email required.' }) };
      }
      const first_name = typeof body.first_name === 'string' ? body.first_name.trim() : '';
      if (!first_name || first_name.length > 80) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'first_name required (1–80 chars).' }) };
      }
      const last_name = typeof body.last_name === 'string' ? body.last_name.trim() : '';
      if (!last_name || last_name.length > 80) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'last_name required (1–80 chars).' }) };
      }
      const role = typeof body.role === 'string' ? body.role : '';
      const ALLOWED_ROLES = new Set(['Clinical', 'Non-Clinical']);
      if (!ALLOWED_ROLES.has(role)) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: "role must be 'Clinical' or 'Non-Clinical'." }),
        };
      }
      let prefix = null;
      if ('prefix' in body && body.prefix != null) {
        if (typeof body.prefix !== 'string') {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'prefix must be a string.' }) };
        }
        prefix = body.prefix.trim();
        if (prefix.length > 8) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'prefix must be 8 characters or fewer.' }) };
        }
        if (prefix.length === 0) prefix = null;
      }
      let suffix = null;
      if ('suffix' in body && body.suffix != null) {
        if (typeof body.suffix !== 'string') {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'suffix must be a string.' }) };
        }
        suffix = body.suffix.trim();
        if (suffix.length > 24) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'suffix must be 24 characters or fewer.' }) };
        }
        if (suffix.length === 0) suffix = null;
      }

      // Side effects start here.
      //
      // Supabase admin /auth/v1/invite generates an invite token and
      // emails it to the invitee. user_metadata carries display
      // fields so Supabase's email template can address them by name
      // and so the accept-invite page can render the name from the
      // JWT before any RLS-permitted read happens.
      //
      // redirect_to overrides the dashboard's Site URL. Set
      // INVITE_REDIRECT_URL in Netlify env to pin the destination
      // explicitly; otherwise fall back to {URL}/accept-invite.html
      // (URL is Netlify's auto-set site URL).
      const full_name = [first_name, last_name].filter(Boolean).join(' ');
      const userMeta = { first_name, last_name, full_name, role, company_id };
      if (prefix) userMeta.prefix = prefix;
      if (suffix) userMeta.suffix = suffix;

      // redirect_to passed BOTH as a URL query string param AND in
      // the body. Some gotrue versions ignore body-level redirect_to
      // and fall back to the dashboard Site URL — the same class of
      // bug that landed Brad's reset email at `/` instead of
      // /reset-password.html on 2026-05-17. The URL itself must be
      // on the Supabase Auth allow-list (Dashboard → URL
      // Configuration → Redirect URLs), otherwise Supabase silently
      // substitutes the Site URL even when redirect_to is passed
      // correctly.
      const redirectUrl = process.env.INVITE_REDIRECT_URL
        || (process.env.URL ? process.env.URL.replace(/\/$/, '') + '/accept-invite.html' : null);
      const invitePayload = { email, data: userMeta };
      if (redirectUrl) invitePayload.redirect_to = redirectUrl;

      const inviteUrl = `${SUPABASE_URL}/auth/v1/invite`
        + (redirectUrl ? '?redirect_to=' + encodeURIComponent(redirectUrl) : '');
      const inviteRes = await fetch(inviteUrl, {
        method: 'POST',
        headers: serviceH,
        body: JSON.stringify(invitePayload),
      });
      const newUser = await inviteRes.json();
      if (!inviteRes.ok || !newUser.id) {
        // 422 / "User already registered" is the most common failure —
        // surface verbatim so the admin UI can show a clean message.
        const msg = newUser.msg || newUser.message || newUser.error_description
                 || newUser.error || 'Invite failed';
        return { statusCode: inviteRes.status || 400, headers: CORS, body: JSON.stringify({ error: msg }) };
      }

      // Insert the profile row immediately so the pending invite is
      // visible in the Staff admin view. title gets the suffix value
      // for back-compat with the snapshot-rail code in /history and
      // /reviews (mig 0017) that still reads profile.title.
      const profileRow = {
        id: newUser.id,
        company_id,
        role,
        first_name,
        last_name,
        full_name,
        email,
        invited_at: new Date().toISOString(),
        accepted_at: null,
      };
      if (prefix) profileRow.prefix = prefix;
      if (suffix) {
        profileRow.suffix = suffix;
        profileRow.title = suffix;
      }
      await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: 'POST',
        headers: { ...serviceH, 'Prefer': 'return=minimal' },
        body: JSON.stringify(profileRow),
      });

      await fetch(`${SUPABASE_URL}/rest/v1/company_members`, {
        method: 'POST',
        headers: { ...serviceH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ company_id, user_id: newUser.id, role }),
      });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, user_id: newUser.id, email }) };
    }

    // ── POST /auth/accept ─────────────────────────────────────────────────
    //
    // Called by /accept-invite.html after the invitee has set their
    // password via Supabase's PUT /auth/v1/user. Flips accepted_at
    // from null → now() on the caller's own profile row.
    //
    // Safety:
    //   * Only mutates the caller's row (id derived from server-
    //     verified JWT, never from body — caller has no body to send).
    //   * PATCH predicate includes `accepted_at=is.null` so any
    //     replay or second call is a silent no-op rather than
    //     overwriting the original timestamp.
    if (path.includes('/accept') && method === 'POST') {
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const user = await userRes.json();
      if (!user || !user.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }
      const hdr = serviceH || userH;
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&accepted_at=is.null`,
        {
          method: 'PATCH',
          headers: { ...hdr, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ accepted_at: new Date().toISOString() }),
        }
      );
      if (!res.ok) {
        console.error('auth.accept:', res.status);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'accept failed' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    // ── GET /auth/staff ───────────────────────────────────────────────────
    //
    // Super-user-only listing of every profile in the caller's tenant,
    // used by the Staff admin tab. Same gate as /auth/invite. Tenant
    // is server-derived; the query is hard-scoped to caller's company_id
    // (never read from query string).
    if (path.includes('/staff') && method === 'GET') {
      if (!serviceH) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not configured' }) };
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };
      const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const caller = await callerRes.json();
      if (!caller || !caller.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }
      const callerProfRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${caller.id}&select=is_super_user,company_id`,
        { headers: serviceH }
      );
      const callerProfiles = await callerProfRes.json();
      const callerProfile = Array.isArray(callerProfiles) && callerProfiles[0] ? callerProfiles[0] : null;
      if (!callerProfile || !callerProfile.is_super_user) {
        return {
          statusCode: 403,
          headers: CORS,
          body: JSON.stringify({ error: 'Super-user access required.', code: 'super_user_only' }),
        };
      }
      if (!callerProfile.company_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Caller has no company_id.' }) };
      }
      const listRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?company_id=eq.${callerProfile.company_id}` +
        `&select=id,email,first_name,last_name,full_name,prefix,suffix,role,title,is_admin,is_super_user,invited_at,accepted_at,created_at,last_seen,triages_completed` +
        `&order=created_at.desc`,
        { headers: serviceH }
      );
      const staff = await listRes.json();
      if (!Array.isArray(staff)) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'staff list fetch failed' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ staff }) };
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
