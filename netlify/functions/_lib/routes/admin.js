// _lib/routes/admin.js
//
// Admin endpoints (v0.3.27). Three sub-paths:
//
//   /admin/users      — list and edit users in caller's tenant.
//                       admin required. is_super_user toggle
//                       requires the caller to already be one.
//
//   /admin/categories — read/edit category_metadata for caller's
//                       tenant. super-user required. Drives the
//                       non-clinical-vs-clinical picker visibility.
//
//   /admin/settings   — read/edit tenant settings (currently just
//                       non_clinical_handoff_template). super-user
//                       required.
//
// Tenant scoping: an admin can only manage their own tenant. Every
// PATCH/SELECT includes company_id=eq.<callers> in the WHERE.
// Cross-tenant admin lives in the Supabase Dashboard, not here.
//
// Extracted from kb.js inline handler (v0.4.0).

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_KEY,
  writeHeaders,
  json,
} = require("../supabase");

const {
  verifyUser,
  resolveProfile,
  extractToken,
} = require("../auth");

const {
  isAdmin,
  isSuperUser,
} = require("../permissions");

// /admin/users handler
async function handleUsers(event, ctx) {
  const { method, callerProfile, callerCompanyId, user } = ctx;

  if (method === "GET") {
    if (!callerCompanyId) {
      return json(400, { error: "Caller has no company_id; cannot list tenant users." });
    }
    // Get profile rows for the tenant
    const profilesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?company_id=eq.${encodeURIComponent(callerCompanyId)}&select=id,full_name,role,title,is_admin,is_super_user,last_seen,created_at&order=created_at.asc`,
      { headers: writeHeaders() }
    );
    const profileRows = await profilesRes.json();
    if (!Array.isArray(profileRows)) {
      return json(500, { error: "Could not load profiles.", detail: profileRows });
    }
    // Fetch emails from auth.users via the Supabase Auth admin
    // REST endpoint. Service key required — anon key won't work
    // for /auth/v1/admin/users. Falls back to empty email map
    // (UI shows "(no email)") if the call fails.
    const adminKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
      headers: {
        "apikey": adminKey,
        "Authorization": "Bearer " + adminKey,
      },
    });
    let emailByUserId = {};
    if (authRes.ok) {
      const authData = await authRes.json();
      const users = Array.isArray(authData) ? authData : (authData.users || []);
      users.forEach(u => { emailByUserId[u.id] = u.email; });
    }
    const enriched = profileRows.map(p => Object.assign({}, p, {
      email: emailByUserId[p.id] || null,
    }));
    return json(200, enriched);
  }

  if (method === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return json(400, { error: "Invalid JSON body." }); }

    if (body.action === "update_role") {
      // Patch role and/or flag fields on a profile in caller's
      // tenant. Defensive against:
      //   - Promoting a user to super_user without being one
      //     yourself (only super_user can grant super_user)
      //   - Removing your own admin/super_user (lock-out risk)
      //   - Promoting users in other tenants (tenant-scope patch)
      if (!body.user_id) return json(400, { error: "user_id required" });
      if (!callerCompanyId) return json(400, { error: "Caller has no company_id." });
      const patch = {};
      if ('role' in body) {
        if (body.role !== 'Clinical' && body.role !== 'Non-Clinical') {
          return json(400, { error: "role must be 'Clinical' or 'Non-Clinical'." });
        }
        patch.role = body.role;
      }
      if ('is_admin' in body) {
        if (typeof body.is_admin !== 'boolean') {
          return json(400, { error: "is_admin must be boolean." });
        }
        patch.is_admin = body.is_admin;
      }
      if ('is_super_user' in body) {
        if (typeof body.is_super_user !== 'boolean') {
          return json(400, { error: "is_super_user must be boolean." });
        }
        // Only super-users can grant or revoke super_user. Same
        // principle as "only root can promote to root" — closes
        // the privilege-escalation hole where a regular admin
        // could grant themselves super_user flag.
        if (!isSuperUser(callerProfile)) {
          return json(403, {
            error: "Only super-users can change is_super_user.",
            code: "super_user_only",
          });
        }
        patch.is_super_user = body.is_super_user;
      }
      if ('title' in body) {
        // Free-text display credential (migration 0017). Allow
        // null to clear. Trim and bound at 24 chars; no DB CHECK
        // (see migration comment). Length cap kept in sync with
        // /auth/invite's identical validation.
        if (body.title === null) {
          patch.title = null;
        } else if (typeof body.title !== 'string') {
          return json(400, { error: "title must be a string or null." });
        } else {
          const t = body.title.trim();
          if (t.length > 24) {
            return json(400, { error: "title must be 24 characters or fewer." });
          }
          patch.title = t.length === 0 ? null : t;
        }
      }
      if (Object.keys(patch).length === 0) {
        return json(400, { error: "No fields to update." });
      }
      // Self-demotion guard: refuse to remove your own super_user
      // flag (would lock you out of category/settings management
      // until another super_user re-grants it). Self-removing
      // is_admin is allowed — there might be another admin in
      // the tenant.
      if (body.user_id === user.id && 'is_super_user' in patch && patch.is_super_user === false) {
        return json(400, {
          error: "Cannot revoke your own super-user flag. Ask another super-user.",
          code: "self_demotion_blocked",
        });
      }
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(body.user_id)}&company_id=eq.${encodeURIComponent(callerCompanyId)}`,
        {
          method: "PATCH",
          headers: writeHeaders(),
          body: JSON.stringify(patch),
        }
      );
      const responseText = await r.text();
      if (r.ok) {
        try {
          const parsed = JSON.parse(responseText);
          if (Array.isArray(parsed) && parsed.length === 0) {
            return json(404, { error: "User not found in caller's tenant." });
          }
        } catch (e) { /* fall through */ }
      }
      return json(r.status, responseText);
    }
    return json(400, { error: "Unknown action for /admin/users." });
  }

  return json(405, { error: "Method not allowed." });
}

// /admin/categories handler — super-user only
async function handleCategories(event, ctx) {
  const { method, callerProfile, callerCompanyId } = ctx;
  if (!isSuperUser(callerProfile)) {
    return json(403, { error: "Super-user access required.", code: "super_user_only" });
  }
  if (!callerCompanyId) {
    return json(400, { error: "Caller has no company_id." });
  }

  if (method === "GET") {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/category_metadata?company_id=eq.${encodeURIComponent(callerCompanyId)}&order=display_order.asc,category_name.asc`,
      { headers: writeHeaders() }
    );
    return json(r.status, await r.text());
  }

  if (method === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return json(400, { error: "Invalid JSON body." }); }

    if (body.action === "update") {
      if (!body.id) return json(400, { error: "id required" });
      const patch = { updated_at: new Date().toISOString() };
      if (typeof body.is_clinical === 'boolean') patch.is_clinical = body.is_clinical;
      if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
      if (typeof body.display_order === 'number') patch.display_order = body.display_order;
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/category_metadata?id=eq.${encodeURIComponent(body.id)}&company_id=eq.${encodeURIComponent(callerCompanyId)}`,
        {
          method: "PATCH",
          headers: writeHeaders(),
          body: JSON.stringify(patch),
        }
      );
      return json(r.status, await r.text());
    }
    if (body.action === "create") {
      if (!body.category_name) return json(400, { error: "category_name required" });
      const record = {
        company_id: callerCompanyId,
        category_name: body.category_name,
        is_clinical: typeof body.is_clinical === 'boolean' ? body.is_clinical : true,
        display_order: typeof body.display_order === 'number' ? body.display_order : 100,
        is_active: true,
      };
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/category_metadata`,
        { method: "POST", headers: writeHeaders(), body: JSON.stringify(record) }
      );
      return json(r.status, await r.text());
    }
    return json(400, { error: "Unknown action for /admin/categories." });
  }

  return json(405, { error: "Method not allowed." });
}

// /admin/settings handler — super-user only
async function handleSettings(event, ctx) {
  const { method, callerProfile, callerCompanyId } = ctx;
  if (!isSuperUser(callerProfile)) {
    return json(403, { error: "Super-user access required.", code: "super_user_only" });
  }
  if (!callerCompanyId) {
    return json(400, { error: "Caller has no company_id." });
  }

  if (method === "GET") {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(callerCompanyId)}&select=id,name,non_clinical_handoff_template`,
      { headers: writeHeaders() }
    );
    return json(r.status, await r.text());
  }

  if (method === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return json(400, { error: "Invalid JSON body." }); }

    if (body.action === "update_handoff_template") {
      if (typeof body.template !== 'string' || !body.template.trim()) {
        return json(400, { error: "template (non-empty string) required" });
      }
      // Cap length defensively — a 50KB handoff template is
      // either a paste accident or hostile.
      if (body.template.length > 4000) {
        return json(400, { error: "template too long (max 4000 chars)" });
      }
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(callerCompanyId)}`,
        {
          method: "PATCH",
          headers: writeHeaders(),
          body: JSON.stringify({ non_clinical_handoff_template: body.template }),
        }
      );
      return json(r.status, await r.text());
    }
    return json(400, { error: "Unknown action for /admin/settings." });
  }

  return json(405, { error: "Method not allowed." });
}

// Top-level dispatcher for /admin/*. Resolves caller, enforces
// admin flag, then routes by sub-path.
async function handle(event) {
  const path = event.path || "";
  const method = event.httpMethod;
  const token = extractToken(event);

  const user = await verifyUser(token);
  if (!user) return json(401, { error: "Authentication required." });
  const callerProfile = await resolveProfile(user);
  if (!isAdmin(callerProfile)) {
    return json(403, { error: "Admin access required.", code: "admin_only" });
  }
  const callerCompanyId = callerProfile.company_id;

  const ctx = { method, callerProfile, callerCompanyId, user };

  if (path.includes("/admin/users"))      return handleUsers(event, ctx);
  if (path.includes("/admin/categories")) return handleCategories(event, ctx);
  if (path.includes("/admin/settings"))   return handleSettings(event, ctx);
  return json(404, { error: "Unknown admin endpoint." });
}

module.exports = { handle };
