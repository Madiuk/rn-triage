// _lib/routes/profile.js
//
// Three small read-only endpoints needed by the frontend during
// session init and during the Inquiry flow:
//
//   GET /profile          — caller's own profile (role + flags +
//                           company_id). Used by initAuth to
//                           populate currentProfile so UI gates
//                           render correctly. Any authenticated
//                           user can read their own profile.
//
//   GET /handoff-template — caller's tenant's non-clinical handoff
//                           template. Read by the frontend's
//                           loadHandoffTemplate() and rendered in
//                           renderNonClinicalHandoff. Edited only
//                           via /admin/settings.
//
//   GET /categories       — active category_metadata for the
//                           caller's tenant. Reserved for the
//                           future Tasks/picker workflow that
//                           filters by is_clinical based on role.
//                           Not yet consumed by the UI.
//
// Extracted from kb.js inline handlers (v0.4.0). Each is a single
// read; no mutations.

const {
  SUPABASE_URL,
  writeHeaders,
  json,
} = require("../supabase");

const {
  verifyUser,
  resolveCompanyId,
  resolveProfile,
  extractToken,
} = require("../auth");

// GET /profile — caller's own profile row.
async function handleProfile(event) {
  const token = extractToken(event);
  const user = await verifyUser(token);
  if (!user) return json(401, { error: "Authentication required." });
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed." });

  const profile = await resolveProfile(user);
  if (!profile) return json(404, { error: "Profile not found." });
  return json(200, profile);
}

// GET /handoff-template — caller's tenant's handoff template.
async function handleHandoffTemplate(event) {
  const token = extractToken(event);
  const user = await verifyUser(token);
  if (!user) return json(401, { error: "Authentication required." });
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed." });

  const companyId = await resolveCompanyId(user);
  if (!companyId) return json(400, { error: "Caller has no company_id." });

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(companyId)}&select=non_clinical_handoff_template`,
    { headers: writeHeaders() }
  );
  return json(r.status, await r.text());
}

// GET /categories — active category_metadata for caller's tenant.
async function handleCategories(event) {
  const token = extractToken(event);
  const user = await verifyUser(token);
  if (!user) return json(401, { error: "Authentication required." });
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed." });

  const companyId = await resolveCompanyId(user);
  if (!companyId) return json(400, { error: "Caller has no company_id." });

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/category_metadata?company_id=eq.${encodeURIComponent(companyId)}&is_active=eq.true&order=display_order.asc,category_name.asc`,
    { headers: writeHeaders() }
  );
  return json(r.status, await r.text());
}

module.exports = {
  handleProfile,
  handleHandoffTemplate,
  handleCategories,
};
