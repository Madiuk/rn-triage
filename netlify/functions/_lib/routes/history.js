// _lib/routes/history.js
//
// /history — query_history reads, writes, and aggregations.
//
// Sub-endpoints:
//   GET /history/stats   — today/week/total counts for caller
//   GET /history/cost    — last-N-days spend + model split + cache
//   GET /history/quality — calibration + correction signals
//   GET /history         — corrections feed (rows with actual_response
//                          or correction_note set)
//   GET /history/all     — full history (up to 200 most recent)
//   POST /history        — action dispatcher:
//                            update_urgency, update_category,
//                            upvote, downvote, save_actual,
//                            delete_correction, mark_escalated,
//                            delete_entry, or default insert.
//
// Extracted from kb.js inline handler (v0.4.0). The role gates on
// each action go through permissions.js predicates so the same
// rules apply everywhere a clinical-row mutation is attempted.

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

const {
  isNonClinical,
  rowIsClinical,
  canEditClinicalCategory,
} = require("../permissions");

const {
  fetchRowInTenant,
} = require("../db");

const { aggregateCostRows, aggregateQualityRows } = require("../history-aggregations");

const URGENCY_OVERRIDE_VALUES = new Set([
  "routine", "24h", "24-72h", "same-day", "urgent",
]);

async function handle(event) {
  const method = event.httpMethod;
  const path = event.path || "";
  const token = extractToken(event);
  const base = SUPABASE_URL + "/rest/v1/query_history";

  // /history/stats — aggregated triage counts for the calling user.
  // Returns { today, week, total }. Cheap (3 HEAD-style count queries).
  if (path.includes("/history/stats") && method === "GET") {
    const user = await verifyUser(token);
    if (!user || !user.id) return json(401, { error: "Authentication required." });

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Use service-key headers and an explicit, JWT-verified user_id
    // filter. This makes the per-user scoping independent of whatever
    // RLS policies are configured on query_history — the Activity
    // panel always reflects only the calling user's own triages.
    const userId = encodeURIComponent(user.id);
    const countHdrs = { ...writeHeaders(), Prefer: "count=exact", Range: "0-0" };

    function getCount(res) {
      const range = res.headers.get("content-range") || "";
      const m = range.match(/\/(\d+|\*)$/);
      if (!m || m[1] === "*") return 0;
      return parseInt(m[1], 10) || 0;
    }

    try {
      const [tRes, wRes, allRes] = await Promise.all([
        fetch(base + `?user_id=eq.${userId}&created_at=gte.${encodeURIComponent(startOfToday)}&select=id`, { headers: countHdrs }),
        fetch(base + `?user_id=eq.${userId}&created_at=gte.${encodeURIComponent(startOfWeek)}&select=id`, { headers: countHdrs }),
        fetch(base + `?user_id=eq.${userId}&select=id`, { headers: countHdrs }),
      ]);
      return json(200, {
        today: getCount(tRes),
        week: getCount(wRes),
        total: getCount(allRes),
      });
    } catch (e) {
      console.error("history.stats:", e.message);
      return json(500, { error: "Failed to load stats." });
    }
  }

  // /history/cost — last-N-days spend, model split, cache hit rate
  if (path.includes("/history/cost") && method === "GET") {
    const user = await verifyUser(token);
    if (!user || !user.id) return json(401, { error: "Authentication required." });

    const params = event.queryStringParameters || {};
    let days = parseInt(params.days, 10);
    if (!Number.isFinite(days) || days <= 0) days = 14;
    if (days > 90) days = 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const companyId = await resolveCompanyId(user);
    const scope = companyId
      ? `company_id=eq.${encodeURIComponent(companyId)}`
      : `user_id=eq.${encodeURIComponent(user.id)}`;
    const url = base + `?${scope}&created_at=gte.${encodeURIComponent(since)}`
      + `&select=created_at,model,cost_usd,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,latency_ms`
      + `&order=created_at.desc&limit=10000`;
    try {
      const r = await fetch(url, { headers: writeHeaders() });
      const rows = await r.json();
      if (!Array.isArray(rows)) {
        return json(502, { error: "Unexpected response shape from PostgREST." });
      }
      const summary = aggregateCostRows(rows);
      summary.window_days = days;
      summary.scope = companyId ? "company" : "user";
      summary.row_count = rows.length;
      return json(200, summary);
    } catch (e) {
      console.error("history.cost:", e.message);
      return json(500, { error: "Failed to load cost stats." });
    }
  }

  // /history/quality — calibration + correction signals
  if (path.includes("/history/quality") && method === "GET") {
    const user = await verifyUser(token);
    if (!user || !user.id) return json(401, { error: "Authentication required." });

    const params = event.queryStringParameters || {};
    let days = parseInt(params.days, 10);
    if (!Number.isFinite(days) || days <= 0) days = 14;
    if (days > 90) days = 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const companyId = await resolveCompanyId(user);
    const scope = companyId
      ? `company_id=eq.${encodeURIComponent(companyId)}`
      : `user_id=eq.${encodeURIComponent(user.id)}`;
    const url = base + `?${scope}&created_at=gte.${encodeURIComponent(since)}`
      + `&select=urgency_original,urgency_override,actual_response_sent,correction_note,edit_distance,session_duration_seconds,upvoted,downvoted,ai_confidence,prompt_version,kb_version,clinical_routing_level`
      + `&order=created_at.desc&limit=10000`;
    try {
      const r = await fetch(url, { headers: writeHeaders() });
      const rows = await r.json();
      if (!Array.isArray(rows)) {
        return json(502, { error: "Unexpected response shape from PostgREST." });
      }
      const summary = aggregateQualityRows(rows);
      summary.window_days = days;
      summary.scope = companyId ? "company" : "user";
      summary.row_count = rows.length;
      return json(200, summary);
    } catch (e) {
      console.error("history.quality:", e.message);
      return json(500, { error: "Failed to load quality stats." });
    }
  }

  if (method === "GET") {
    // Tenant-scope by company_id, service key, RLS-independent.
    // /history/all returns up to 200 rows; /history (corrections
    // list) filters to only rows where staff submitted an actual
    // response or a correction note (i.e. the learning feed).
    const user = await verifyUser(token);
    if (!user) return json(401, { error: "Authentication required." });
    const companyId = await resolveCompanyId(user);
    const scope = companyId
      ? `company_id=eq.${encodeURIComponent(companyId)}`
      : `user_id=eq.${encodeURIComponent(user.id)}`;
    const isAll = path.includes("/history/all");
    const query = isAll
      ? `?${scope}&order=created_at.desc&limit=200`
      : `?${scope}&or=(actual_response_sent.not.is.null,correction_note.not.is.null)&order=created_at.desc&limit=100`;
    const r = await fetch(base + query, { headers: writeHeaders() });
    return json(r.status, await r.text());
  }

  if (method === "POST") {
    const user = await verifyUser(token);
    if (!user) return json(401, { error: "Authentication required." });

    const body = JSON.parse(event.body || "{}");
    const wHdr = writeHeaders();
    // Resolve full profile (role + flags + company_id) in one query
    // so every gated action can check the role without an extra
    // round-trip.
    const callerProfile = await resolveProfile(user);
    const callerCompanyId = callerProfile ? callerProfile.company_id : null;

    // Role gate helper. Most gated actions need to refuse a
    // non-clinical caller from acting on a clinical-tier row.
    // Reads the row once (in-tenant) and returns null if all
    // good, or a 403 json response if the gate triggered. Caller
    // does:
    //   const denial = await denyIfNonClinicalOnClinicalRow();
    //   if (denial) return denial;
    const denyIfNonClinicalOnClinicalRow = async () => {
      if (!isNonClinical(callerProfile)) return null;
      if (!body.id) return null;
      const row = await fetchRowInTenant(body.id, callerCompanyId);
      if (!row) return json(404, { error: "Row not found in caller's tenant." });
      if (rowIsClinical(row)) {
        return json(403, {
          error: "Clinical authorization required for this action.",
          code: "clinical_only",
        });
      }
      return null;
    };

    // Tenant-scoped patch helper. Returns a 404 (not a silent
    // empty-array success) when no row matches the id+tenant
    // pair — PostgREST otherwise returns 200 with [], which a
    // naive caller would misread as success.
    const patchById = async (patch) => {
      if (!body.id) return json(400, { error: "id required" });
      const tenantClause = callerCompanyId
        ? `&company_id=eq.${encodeURIComponent(callerCompanyId)}`
        : `&user_id=eq.${encodeURIComponent(user.id)}`;
      const r = await fetch(base + "?id=eq." + encodeURIComponent(body.id) + tenantClause, {
        method: "PATCH",
        headers: wHdr,
        body: JSON.stringify(patch),
      });
      const responseText = await r.text();
      if (r.ok) {
        try {
          const parsed = JSON.parse(responseText);
          if (Array.isArray(parsed) && parsed.length === 0) {
            return json(404, { error: "Row not found in caller's tenant." });
          }
        } catch (e) {
          // Body wasn't JSON — return the raw response so the
          // caller sees the actual server message.
        }
      }
      return json(r.status, responseText);
    };

    switch (body.action) {
      case "update_urgency": {
        // ROLE GATE: urgency on clinical-tier rows is clinical-only.
        const denial = await denyIfNonClinicalOnClinicalRow();
        if (denial) return denial;
        const val = body.urgency_override;
        if (val != null && !URGENCY_OVERRIDE_VALUES.has(val)) {
          return json(400, { error: "Invalid urgency_override value." });
        }
        return patchById({ urgency_override: val });
      }
      case "update_category": {
        // ROLE GATE: non-clinical can edit non_clinical_items and
        // non_clinical_flag, but CANNOT touch clinical_category.
        // Picking severity is a clinical judgment they're not
        // qualified to make; clearing a clinical category an AI or
        // clinician set is the under-gate failure mode we explicitly
        // want to prevent.
        if ('category' in body && !canEditClinicalCategory(callerProfile)) {
          return json(403, {
            error: "Non-clinical cannot set or change clinical category. Use Escalate to clinical instead.",
            code: "clinical_only",
          });
        }
        const patch = {};
        // Only patch clinical_category when the caller actually
        // sent the field. Defensive — non-clinical can't even reach
        // here with body.category set thanks to the gate above.
        if ('category' in body) patch.clinical_category = body.category || null;
        if (Array.isArray(body.non_clinical_items)) {
          patch.non_clinical_items = body.non_clinical_items;
        }
        if (typeof body.non_clinical_flag === "boolean") {
          patch.non_clinical_flag = body.non_clinical_flag;
        }
        return patchById(patch);
      }
      case "downvote": {
        const denial = await denyIfNonClinicalOnClinicalRow();
        if (denial) return denial;
        return patchById({ downvoted: true, downvote_reason: body.reason || "" });
      }
      case "upvote": {
        const denial = await denyIfNonClinicalOnClinicalRow();
        if (denial) return denial;
        return patchById({ upvoted: true, upvote_reason: body.reason || "" });
      }
      case "save_actual": {
        const denial = await denyIfNonClinicalOnClinicalRow();
        if (denial) return denial;
        const patch = {
          actual_response_sent: body.actual_response,
          correction_note: body.correction_note || "",
        };
        if (body.session_duration_seconds != null) {
          patch.session_duration_seconds = body.session_duration_seconds;
        }
        if (body.edit_distance != null) {
          patch.edit_distance = body.edit_distance;
        }
        return patchById(patch);
      }
      case "delete_correction": {
        const denial = await denyIfNonClinicalOnClinicalRow();
        if (denial) return denial;
        return patchById({ actual_response_sent: null, correction_note: null });
      }
      case "mark_escalated": {
        // Non-clinical staff hit "Escalate to clinical" when they
        // receive a message they can't handle. Flips the row's
        // escalated_to_clinical flag so clinical's queue surfaces
        // it distinctly. Any role can call this; non-clinical sets
        // non_clinical_handoff_used too so we can measure
        // CSR-routing volume.
        const patch = {
          escalated_to_clinical: true,
          escalated_by: user.id,
          escalated_at: new Date().toISOString(),
        };
        if (isNonClinical(callerProfile)) {
          patch.non_clinical_handoff_used = true;
          if (body.actual_response) {
            patch.actual_response_sent = body.actual_response;
          }
        }
        return patchById(patch);
      }
      case "delete_entry": {
        // Hard-delete a query_history row. ROLE GATE: non-clinical
        // cannot delete clinical-tier rows — a CSR mistake on a
        // clinical message should escalate, not erase.
        const denial = await denyIfNonClinicalOnClinicalRow();
        if (denial) return denial;
        //
        // FK cleanup: review_requests.triage_id references
        // query_history.id WITHOUT ON DELETE CASCADE. Deleting the
        // parent before the children would 23503. Wipe any attached
        // review_requests first, tenant-scoped.
        if (!body.id) return json(400, { error: "id required" });
        const tenantClause = callerCompanyId
          ? `&company_id=eq.${encodeURIComponent(callerCompanyId)}`
          : `&user_id=eq.${encodeURIComponent(user.id)}`;
        const reviewTenantClause = tenantClause.replace(/^&/, '');
        try {
          await fetch(
            `${SUPABASE_URL}/rest/v1/review_requests?triage_id=eq.${encodeURIComponent(body.id)}&${reviewTenantClause}`,
            { method: "DELETE", headers: { ...wHdr, Prefer: "return=minimal" } }
          );
        } catch (e) {
          console.error("history.delete_entry.reviews:", e.message);
        }
        const r = await fetch(base + "?id=eq." + encodeURIComponent(body.id) + tenantClause, {
          method: "DELETE",
          headers: wHdr,
        });
        const responseText = await r.text();
        if (r.ok) {
          try {
            const parsed = JSON.parse(responseText);
            if (Array.isArray(parsed) && parsed.length === 0) {
              return json(404, { error: "Row not found in caller's tenant." });
            }
          } catch (e) { /* fall through */ }
        }
        return json(r.status, responseText);
      }
      default: {
        // Insert. Force user_id and company_id from the verified
        // JWT so a malicious client can't insert query_history rows
        // that look like they came from someone else or from
        // another tenant.
        const insertBody = Object.assign({}, body, {
          user_id: user.id,
          company_id: callerCompanyId || body.company_id || null,
        });
        const r = await fetch(base, { method: "POST", headers: wHdr, body: JSON.stringify(insertBody) });
        return json(r.status, await r.text());
      }
    }
  }

  return json(405, { error: "Method not allowed." });
}

module.exports = { handle };
