// Care Station — KB / History / Reviews / Analyze / Admin proxy
//
// THIN ROUTER (v0.4.0). All endpoint handlers live in
// netlify/functions/_lib/routes/. Each route module exports
// `handle(event)` and is responsible for its own auth check,
// role gate, tenant scoping, and response shape. This file
// only does:
//
//   1. Fail-fast env-var check
//   2. Substring-match dispatch by path
//   3. Top-level error catch
//
// Endpoints (paths are substring-matched in order — overlapping
// paths like /admin/categories vs /categories rely on /admin
// being checked first):
//
//   /kb                  → routes/kb-crud
//   /history*            → routes/history
//   /reviews             → routes/reviews
//   /analyze             → routes/analyze
//   /admin/users         → routes/admin → handleUsers
//   /admin/categories    → routes/admin → handleCategories (super-user)
//   /admin/settings      → routes/admin → handleSettings (super-user)
//   /handoff-template    → routes/profile → handleHandoffTemplate
//   /categories          → routes/profile → handleCategories
//   /profile             → routes/profile → handleProfile

const { SUPABASE_URL, SUPABASE_ANON_KEY, json } = require("./_lib/supabase");

const analyzeRoute = require("./_lib/routes/analyze");
const profileRoute = require("./_lib/routes/profile");
const kbCrudRoute = require("./_lib/routes/kb-crud");
const reviewsRoute = require("./_lib/routes/reviews");
const adminRoute = require("./_lib/routes/admin");
const historyRoute = require("./_lib/routes/history");

exports.handler = async function (event) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(500, { error: "Supabase not configured." });
  }

  const path = event.path || "";

  try {
    // /kb — exact match (the kb section is the literal /kb path,
    // not a substring — /admin/categories must NOT match here).
    if (path.endsWith("/kb") || path.endsWith("/kb/")) {
      return kbCrudRoute.handle(event);
    }

    // Substring-matched routes. Order matters:
    //   - /admin/categories must be checked BEFORE the generic
    //     /categories handler.
    //   - /handoff-template must be checked BEFORE /categories
    //     and /profile only because that's the order in the
    //     header comment — none of those overlap as substrings.
    if (path.includes("/history"))          return historyRoute.handle(event);
    if (path.includes("/reviews"))          return reviewsRoute.handle(event);
    if (path.includes("/analyze"))          return analyzeRoute.handle(event);
    if (path.includes("/admin"))            return adminRoute.handle(event);
    if (path.includes("/handoff-template")) return profileRoute.handleHandoffTemplate(event);
    if (path.includes("/categories"))       return profileRoute.handleCategories(event);
    if (path.includes("/profile"))          return profileRoute.handleProfile(event);

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("kb.handler:", err.message);
    return json(500, { error: err.message });
  }
};
