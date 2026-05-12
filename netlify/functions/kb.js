// Relai — KB / History / Reviews / Analyze / Admin proxy
// Endpoints:
//   /kb                  (GET, POST)
//   /history             (GET, POST)
//   /history/all         (GET)
//   /history/stats       (GET) — per-user today/week/total counts
//   /history/cost        (GET) — last-N-days spend, model split, cache hit rate
//   /history/quality     (GET) — override / correction / confidence trends
//   /reviews             (GET, POST)
//   /analyze             (POST)
//   /admin/users         (GET, POST)
//   /admin/categories    (GET, POST)
//   /admin/settings      (GET, POST)
//   /profile             (GET)
//   /handoff-template    (GET)
//   /categories          (GET)
//
// v0.4.0 cleanup: helpers extracted into _lib/. This file is in the
// process of being slimmed down to a thin router. Next phase will
// move each route handler into _lib/routes/*.js.

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_KEY,
  readHeaders,
  writeHeaders,
  json,
} = require("./_lib/supabase");

const {
  verifyUser,
  resolveCompanyId,
  resolveProfile,
} = require("./_lib/auth");

const {
  isClinical,
  isNonClinical,
  isAdmin,
  isSuperUser,
  rowIsClinical,
} = require("./_lib/permissions");

const {
  fetchRowInTenant,
  writeAuditLog,
} = require("./_lib/db");

const { aggregateCostRows, aggregateQualityRows } = require("./_lib/history-aggregations");

// Promote a resolved review_request into a kb_entries row. Returns the
// section it was filed under, or null on failure.
async function promoteReviewToKB({ companyId, context, question, answer, resolvedByName }) {
  // Map review context to KB section. kb_gap → notes (general rules),
  // protocol → protocols. Other contexts don't auto-promote.
  const section = context === "kb_gap" ? "notes" : context === "protocol" ? "protocols" : null;
  if (!section || !answer) return null;

  // Compute a stable position (append to end of section). Service
  // key — earlier code used readHeaders() with no token (anon
  // access), which under RLS would return [] and pile every
  // promoted entry at position 0. Real KB drift over time.
  let position = 0;
  try {
    const posRes = await fetch(
      `${SUPABASE_URL}/rest/v1/kb_entries?company_id=eq.${companyId}&section=eq.${section}&select=position&order=position.desc&limit=1`,
      { headers: writeHeaders() }
    );
    const rows = await posRes.json();
    if (Array.isArray(rows) && rows[0] && typeof rows[0].position === "number") {
      position = rows[0].position + 1;
    }
  } catch (e) {
    console.error("kb.promotePosition:", e.message);
  }

  const trimmedQ = (question || "").slice(0, 80);
  const name = `Resolved review — ${trimmedQ || new Date().toISOString().slice(0, 10)}`;
  const content = `Q: ${question || ""}\n\nA: ${answer}`;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kb_entries`, {
      method: "POST",
      headers: { ...writeHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        company_id: companyId,
        section,
        name,
        content,
        position,
        nurse_name: resolvedByName || "Review queue",
      }),
    });
    if (!r.ok) {
      console.error("kb.promoteReviewToKB:", "insert failed", r.status);
      return null;
    }
    return section;
  } catch (e) {
    console.error("kb.promoteReviewToKB:", e.message);
    return null;
  }
}

// json() helper is imported from _lib/supabase above.
// promoteReviewToKB stays inline for now — it's specific to the
// /reviews resolve handler and will move with that route in the
// next extraction pass.

exports.handler = async function (event) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(500, { error: "Supabase not configured." });
  }

  const method = event.httpMethod;
  const path = event.path || "";
  const token = (event.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

  try {
    // ── KB entries ─────────────────────────────────────────────────────────
    if (path.endsWith("/kb") || path.endsWith("/kb/")) {
      const base = SUPABASE_URL + "/rest/v1/kb_entries";

      if (method === "GET") {
        // Tenant-scope by company_id, service key, RLS-independent.
        // verifyUser is required so anonymous callers can't read the
        // KB; the seed gets baked client-side from data/default-kb.js
        // anyway, so unauthenticated access wouldn't expose anything
        // sensitive — but treating /kb as auth-gated is the safer
        // posture for when the KB grows non-clinical operational
        // content (refund policies, escalation paths, etc.).
        const user = await verifyUser(token);
        if (!user) return json(401, { error: "Authentication required." });
        const companyId = await resolveCompanyId(user);
        const scope = companyId
          ? `company_id=eq.${companyId}`
          : `user_id=eq.${encodeURIComponent(user.id)}`;
        const r = await fetch(
          base + `?${scope}&order=section,position`,
          { headers: writeHeaders() }
        );
        return json(r.status, await r.text());
      }

      if (method === "POST") {
        const user = await verifyUser(token);
        if (!user) return json(401, { error: "Authentication required to write KB." });

        const body = JSON.parse(event.body || "{}");
        const newEntries = Array.isArray(body.entries) ? body.entries : [];
        const wHdr = writeHeaders();
        const companyId = await resolveCompanyId(user);

        // Refuse empty saves. The handler's flow is DELETE-then-
        // INSERT, so an empty entries array would mean DELETE-only:
        // every KB row for the tenant is wiped with nothing
        // replacing it. That can happen via state corruption
        // (frontend `kb` global gets emptied somehow), repeated
        // Delete clicks in the inline editor, or a malformed
        // request body. Treat empty as a likely mistake; require
        // explicit confirmation via a separate clear endpoint if
        // we ever need that capability. For now: 400.
        if (!newEntries.length) {
          return json(400, {
            error: "Refusing to save an empty KB. If you intended to clear the KB, contact an admin — there is no client-facing path that should produce this.",
          });
        }

        // Defense-in-depth: every entry's company_id must match the
        // verified user's company_id. The frontend now always sends
        // it (see buildEntries in app.js), but a malicious or
        // buggy client could send entries with another tenant's
        // company_id, which would either INSERT into the wrong
        // tenant (cross-tenant data write) or be silently dropped
        // by RLS. Forcing it server-side guarantees writes land in
        // the verified tenant's KB regardless of what the client
        // sent.
        for (let i = 0; i < newEntries.length; i++) {
          if (companyId) {
            newEntries[i].company_id = companyId;
          } else if (newEntries[i].company_id) {
            // No company_id resolved for this user but entry has
            // one — refuse rather than allow cross-tenant writes
            // through a profile-without-company_id account.
            return json(403, { error: "Caller has no resolved company_id; cannot save entries that target a specific tenant." });
          }
        }

        // Snapshot current entries first so we can restore on failure.
        // CRITICAL: the snapshot must use the service key, not the
        // user JWT. Earlier code used readHeaders(token) here, which
        // means RLS could silently return [] — and an empty snapshot
        // followed by the DELETE-then-INSERT below would mean a failed
        // INSERT had nothing to restore from. The DELETE always
        // succeeds because it's service-key. The whole KB could vanish
        // with no recovery if the AI insert payload had a schema
        // problem.
        const snapScope = companyId
          ? `company_id=eq.${companyId}`
          : `user_id=eq.${encodeURIComponent(user.id)}`;
        let backup = [];
        try {
          const cur = await fetch(base + "?" + snapScope + "&select=*", { headers: wHdr });
          if (cur.ok) backup = await cur.json();
        } catch (e) {
          console.error("kb.snapshot:", e.message);
        }

        // Tenant-scoped delete — never blow away another tenant's KB.
        const delScope = companyId
          ? `company_id=eq.${companyId}`
          : `user_id=eq.${encodeURIComponent(user.id)}`;
        const delRes = await fetch(base + "?" + delScope, {
          method: "DELETE",
          headers: wHdr,
        });
        if (!delRes.ok) {
          return json(delRes.status, { error: "Failed to clear KB before write." });
        }

        // (Empty-entries refusal lives at the top of this handler —
        // pre-snapshot, pre-delete — so we never reach a state where
        // the KB is deleted with nothing replacing it.)

        const insRes = await fetch(base, {
          method: "POST",
          headers: wHdr,
          body: JSON.stringify(newEntries),
        });

        if (!insRes.ok) {
          // Restore the snapshot. Best-effort — drop server-generated columns
          // PostgREST will reject (id is fine to keep).
          if (backup.length) {
            try {
              await fetch(base, {
                method: "POST",
                headers: wHdr,
                body: JSON.stringify(backup),
              });
            } catch (e) {
              console.error("kb.restore:", e.message);
            }
          }
          return json(insRes.status, { error: "KB write failed; previous entries restored." });
        }

        await writeAuditLog({
          company_id: companyId,
          actor_id: user.id,
          event_type: "kb.replace",
          entity_type: "kb_entries",
          payload: { count: newEntries.length, prior_count: backup.length },
        });

        return json(200, await insRes.text());
      }
    }

    // ── Query history ─────────────────────────────────────────────────────
    if (path.includes("/history")) {
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
          console.error("kb.historyStats:", e.message);
          return json(500, { error: "Failed to load stats." });
        }
      }

      // /history/cost — last-N-days spend, model split, cache hit rate
      // for the calling user's tenant. Read-only aggregation off the
      // observability columns added in migration 0005.
      //
      // Query params:
      //   ?days=14   how many days back to summarize (default 14, max 90)
      //
      // Service-key read scoped to the verified user's company_id —
      // RLS-independent, like /history/stats.
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
          ? `company_id=eq.${companyId}`
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
          console.error("kb.historyCost:", e.message);
          return json(500, { error: "Failed to load cost stats." });
        }
      }

      // /history/quality — calibration + correction signals over the
      // last N days, scoped the same way as /history/cost. Surfaces:
      //   - urgency_override_rate: how often staff disagreed with the AI's urgency
      //   - correction_rate: how often staff edited the draft
      //   - mean edit_distance, mean session_duration_seconds
      //   - upvote_rate / downvote_rate
      //   - mean ai_confidence vs override rate (calibration sanity check)
      // These are the inputs for "is the AI getting better or worse over
      // time?" — track them per prompt_version to attribute changes.
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
          ? `company_id=eq.${companyId}`
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
          console.error("kb.historyQuality:", e.message);
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
          ? `company_id=eq.${companyId}`
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
        // v0.3.27: resolve full profile (role + flags + company_id)
        // in one query so every gated action can check the role
        // without an extra round-trip. callerCompanyId stays the same
        // variable name everything downstream already uses.
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

        // Tenant-scoped patch. Earlier the WHERE was `id=eq.<body.id>`
        // alone — meaning a user with a valid JWT could PATCH ANY
        // query_history row by passing its id. The id is a UUID and
        // hard to guess, but defense-in-depth: we add
        // `company_id=eq.<theirs>` to the WHERE so cross-tenant
        // patches affect zero rows. user_id fallback is for
        // legacy rows that were inserted with company_id=null
        // before the v0.3.6 buildEntries fix.
        //
        // Surface 0-rows-affected as 404 — PostgREST with
        // `return=representation` returns 200 with an empty array
        // when the WHERE matched nothing, which a naive caller would
        // misread as "patch succeeded." Empty array = no row owned
        // by this caller matched that id = the legitimate failure
        // mode for both "id doesn't exist" and "id belongs to
        // another tenant."
        const patchById = async (patch) => {
          if (!body.id) return json(400, { error: "id required" });
          const tenantClause = callerCompanyId
            ? `&company_id=eq.${callerCompanyId}`
            : `&user_id=eq.${encodeURIComponent(user.id)}`;
          const r = await fetch(base + "?id=eq." + body.id + tenantClause, {
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

        // Whitelist of values that urgency_override can be set to.
        // The dropdown supports a few "sub-routine" intervals
        // (24h / 24-72h) that the AI itself never produces — those
        // are staff-only refinements. Anything outside this set is
        // a client bug or a tampered payload, and we reject it
        // rather than letting junk strings pollute aggregations
        // that look up urgency_override later.
        const URGENCY_OVERRIDE_VALUES = new Set([
          "routine", "24h", "24-72h", "same-day", "urgent",
        ]);

        switch (body.action) {
          case "update_urgency": {
            // ROLE GATE: urgency on clinical-tier rows is clinical-only.
            // Non-clinical staff don't make priority decisions on
            // medical content. Same gate fires on every clinical-row
            // mutation below.
            const denial = await denyIfNonClinicalOnClinicalRow();
            if (denial) return denial;
            const val = body.urgency_override;
            if (val != null && !URGENCY_OVERRIDE_VALUES.has(val)) {
              return json(400, { error: "Invalid urgency_override value." });
            }
            return patchById({ urgency_override: val });
          }
          case "update_category": {
            // Persist clinical + non-clinical category corrections in
            // their own columns. The frontend used to send a single
            // concatenated string ("Side Effects | Non-clinical:
            // Billing/Payment") into clinical_category, which broke
            // category-based aggregations downstream. Now: clinical
            // selections go into clinical_category, non-clinical into
            // non_clinical_items (+ flag), independent.
            //
            // ROLE GATE: non-clinical can edit non_clinical_items and
            // non_clinical_flag, but CANNOT touch clinical_category.
            // Picking severity is a clinical judgment they're not
            // qualified to make; clearing a clinical category an AI
            // or clinician set is the under-gate failure mode we
            // explicitly want to prevent (triage-lib.js comment on
            // requiresClinicalAuthorization).
            if (isNonClinical(callerProfile)) {
              // `body.category` is the clinical category field; if
              // the client sent it at all, reject the request rather
              // than silently dropping it. Silent drops mislead the
              // UI into thinking the save succeeded.
              if ('category' in body) {
                return json(403, {
                  error: "Non-clinical cannot set or change clinical category. Use Escalate to clinical instead.",
                  code: "clinical_only",
                });
              }
            }
            const patch = {};
            // Only patch clinical_category when the caller actually
            // sent the field. Earlier we always patched it (defaulting
            // to null) — that meant non-clinical edits to JUST the
            // non_clinical_items would nuke clinical_category as a
            // side effect. With the gate above, non-clinical can't
            // send `category` anyway, but defensive: only patch what
            // the caller explicitly provided.
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
            // ROLE GATE: voting on a clinical draft is a clinical
            // judgment about the AI's medical content. Non-clinical
            // can downvote on non-clinical drafts only.
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
            // ROLE GATE: actual_response_sent on a clinical-tier row
            // is the input the Haiku correction analyzer reads to
            // generate learning notes. Allowing a non-clinical save
            // here would let CSR edits to clinical responses pollute
            // the learning loop. Strict refusal.
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
            // v0.3.27: Non-clinical staff hit "Escalate to clinical"
            // when they receive a message they can't handle. Flips
            // the row's escalated_to_clinical flag so clinical's
            // queue surfaces it distinctly. Any role can call this
            // (clinical might use it too if they want to flag a row
            // for a colleague's attention), but the common case is
            // non-clinical's only outlet for clinical content.
            //
            // Also records non_clinical_handoff_used when the caller
            // is non-clinical, so we can measure CSR-routing volume.
            const patch = {
              escalated_to_clinical: true,
              escalated_by: user.id,
              escalated_at: new Date().toISOString(),
            };
            if (isNonClinical(callerProfile)) {
              patch.non_clinical_handoff_used = true;
              // If body includes actual_response (the handoff text
              // they sent the patient), persist it. Treated the same
              // as save_actual but allowed for non-clinical because
              // the content is the static handoff template, not a
              // CSR-authored clinical reply.
              if (body.actual_response) {
                patch.actual_response_sent = body.actual_response;
              }
            }
            return patchById(patch);
          }
          case "delete_entry": {
            // Hard-delete a query_history row. Used when staff entered
            // the wrong content (e.g. pasted their own reply into the
            // patient-message field) and want the row gone so it
            // doesn't pollute the learning loop or aggregations.
            //
            // ROLE GATE: non-clinical cannot delete clinical-tier
            // rows. A CSR might paste a clinical message and want to
            // undo, but a delete also wipes the AI's classification
            // and would erase the escalation trail. Non-clinical can
            // mark_escalated; if they want a row truly gone, ask a
            // clinician to delete.
            const denial = await denyIfNonClinicalOnClinicalRow();
            if (denial) return denial;
            //
            // FK cleanup: review_requests.triage_id references
            // query_history.id WITHOUT ON DELETE CASCADE (see
            // migrations/0001_baseline.sql). Deleting the parent
            // before the children would 23503. Wipe any attached
            // review_requests first, tenant-scoped so a malicious
            // caller can't nuke another tenant's reviews by passing a
            // foreign triage_id.
            //
            // KB entries already promoted from this triage live in a
            // separate `kb_entries` row and are intentionally NOT
            // touched — the lesson the AI learned survives the
            // deletion of its origin triage. If staff want to undo a
            // KB promotion they do that from the KB tab.
            if (!body.id) return json(400, { error: "id required" });
            const tenantClause = callerCompanyId
              ? `&company_id=eq.${callerCompanyId}`
              : `&user_id=eq.${encodeURIComponent(user.id)}`;
            // Reviews are looked up by triage_id, but tenant-scope on
            // the review's OWN company_id (the FK doesn't enforce
            // tenant alignment). Strip the leading & so it works as
            // the first filter clause after `?`.
            const reviewTenantClause = tenantClause.replace(/^&/, '');
            try {
              await fetch(
                `${SUPABASE_URL}/rest/v1/review_requests?triage_id=eq.${body.id}&${reviewTenantClause}`,
                { method: "DELETE", headers: { ...wHdr, Prefer: "return=minimal" } }
              );
            } catch (e) {
              // Reviews cleanup is best-effort: if it fails the
              // query_history delete will FK-violate and we'll
              // surface the error from there. Don't crash the
              // handler.
              console.error("kb.delete_entry.reviews:", e.message);
            }
            const r = await fetch(base + "?id=eq." + body.id + tenantClause, {
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
              } catch (e) {
                // Body wasn't JSON; fall through to return what
                // PostgREST sent.
              }
            }
            return json(r.status, responseText);
          }
          default: {
            // Insert. Force user_id and company_id from the verified
            // JWT so a malicious client can't insert query_history
            // rows that look like they came from someone else or
            // from another tenant. The frontend already sends these
            // (correctly, from currentUser/currentProfile), so this
            // is defense-in-depth — but it's the kind of guard
            // every cross-tenant write should have.
            const insertBody = Object.assign({}, body, {
              user_id: user.id,
              company_id: callerCompanyId || body.company_id || null,
            });
            const r = await fetch(base, { method: "POST", headers: wHdr, body: JSON.stringify(insertBody) });
            return json(r.status, await r.text());
          }
        }
      }
    }

    // ── Reviews (AI Review Queue) ─────────────────────────────────────────
    if (path.includes("/reviews")) {
      const base = SUPABASE_URL + "/rest/v1/review_requests";

      if (method === "GET") {
        // Tenant-scope by company_id, service key, RLS-independent.
        // CRITICAL: this endpoint feeds the Pending Review Items
        // badge AND the active learning loop (resolved reviews →
        // KB inserts). If RLS denied SELECT here — which is what
        // would happen on a fresh deploy from migrations alone —
        // every AI-flagged uncertainty would be invisible to staff
        // and the KB would never auto-improve from staff answers.
        const user = await verifyUser(token);
        if (!user) return json(401, { error: "Authentication required." });
        const companyId = await resolveCompanyId(user);
        const scope = companyId
          ? `company_id=eq.${companyId}`
          : `created_by=eq.${encodeURIComponent(user.id)}`;
        const r = await fetch(
          base + `?${scope}&order=created_at.desc&limit=100`,
          { headers: writeHeaders() }
        );
        return json(r.status, await r.text());
      }

      if (method === "POST") {
        const user = await verifyUser(token);
        if (!user) return json(401, { error: "Authentication required." });

        const body = JSON.parse(event.body || "{}");
        const wHdr = writeHeaders();
        // v0.3.27: resolve full profile so we can role-gate the resolve
        // action. Create is open to any authenticated user — the AI
        // emits review_request from any triage and we want whoever
        // ran the triage to be able to persist it.
        const callerProfile = await resolveProfile(user);
        const callerCompanyId = callerProfile ? callerProfile.company_id : null;

        if (body.action === "create") {
          // Force company_id to the verified user's company. Earlier
          // we trusted whatever the client sent, which would let a
          // malicious client create review rows in another tenant.
          const record = {
            triage_id: body.triage_id || null,
            company_id: callerCompanyId || body.company_id || null,
            created_by: user.id,                              // forced from JWT
            question: body.question || "",
            context: body.context || "general",
            confidence: body.confidence != null ? body.confidence : null,
            patient_message: body.patient_message || "",
            ai_draft: body.ai_draft || "",
            status: "pending",
          };
          const r = await fetch(base, { method: "POST", headers: wHdr, body: JSON.stringify(record) });
          return json(r.status, await r.text());
        }

        if (body.action === "resolve") {
          // Look up the review row first so we can route the answer
          // correctly even if the client doesn't send context/
          // company_id. Service key (NOT user JWT) — earlier code
          // used readHeaders(token) here, which means RLS could
          // silently return [] and `review` would be null. With
          // null, companyId falls through to null below, the
          // kb_gap/protocol branch's `if (companyId && ...)` short-
          // circuits, and promoteReviewToKB never runs. That broke
          // the entire active learning loop silently — every staff
          // answer to an AI-flagged review was being saved on the
          // review row but never promoted into the KB.
          let review = null;
          try {
            const lookup = await fetch(base + "?id=eq." + body.id + "&select=*", { headers: writeHeaders() });
            const arr = await lookup.json();
            if (Array.isArray(arr) && arr[0]) review = arr[0];
          } catch (e) { console.error("kb.reviewLookup:", e.message); }

          if (!review) return json(404, { error: "Review not found." });

          // Tenant check: caller's company_id must match the review
          // row's company_id. Without this, a user with any valid
          // session could resolve another tenant's reviews —
          // injecting their answer into the wrong tenant's KB.
          if (callerCompanyId && review.company_id && review.company_id !== callerCompanyId) {
            return json(403, { error: "Cross-tenant review resolve refused." });
          }

          // ROLE GATE (v0.3.27): non-clinical staff cannot resolve
          // reviews originating from clinical-tier triages. The
          // resolved answer feeds the active learning loop — a CSR's
          // clinical answer would inject non-licensed content into
          // the clinical KB. Look up the originating triage to
          // determine tier.
          if (isNonClinical(callerProfile) && review.triage_id) {
            const originTriage = await fetchRowInTenant(review.triage_id, callerCompanyId);
            if (originTriage && rowIsClinical(originTriage)) {
              return json(403, {
                error: "Clinical reviews can only be resolved by clinical staff.",
                code: "clinical_only",
              });
            }
          }

          // Block double-resolve. The review row already has a
          // resolved/dismissed state; resolving again would promote
          // a duplicate kb_entries row, double-write the audit log,
          // and return a misleading "saved" to the caller. Most
          // likely cause: rapid double-click or two open tabs both
          // hitting submit. The frontend disables the button, but
          // a second tab won't see that.
          if (review.status && review.status !== "pending") {
            return json(409, {
              error: "Review already " + review.status + ". Refusing to re-resolve.",
              status: review.status,
            });
          }

          const ctx = body.context || review.context || "general";
          const companyId = review.company_id || callerCompanyId || null;

          // Decide what to do with the answer. kb_gap / protocol promote
          // into kb_entries; other contexts are saved on the review row only.
          //
          // Three distinct outcomes — DON'T collapse them:
          //   - 'kb':           context was kb-eligible AND promotion succeeded.
          //   - 'kb_failed':    context was kb-eligible BUT promotion failed
          //                     (network blip, schema constraint, etc.).
          //                     Previously this was silently collapsed into
          //                     'confirmation', so the staff saw a success
          //                     message while their answer never reached the
          //                     KB. The AI would keep producing the same
          //                     gap, the user would keep answering it,
          //                     learning loop never closed.
          //   - 'confirmation': context wasn't kb-eligible (routing,
          //                     severity, category, general).
          let appliedTo = "confirmation";
          let promotedSection = null;
          if (companyId && (ctx === "kb_gap" || ctx === "protocol")) {
            promotedSection = await promoteReviewToKB({
              companyId,
              context: ctx,
              question: body.question || (review && review.question) || "",
              answer: body.answer || "",
              resolvedByName: body.resolved_by_name || null,
            });
            if (promotedSection) {
              appliedTo = "kb";
            } else {
              appliedTo = "kb_failed";
              console.error("kb.resolveReview.promotionFailed:", { reviewId: body.id, companyId, context: ctx });
            }
          }

          const patch = {
            status: "resolved",
            answer: body.answer || "",
            applied_to: appliedTo,
            resolved_by: user.id,                              // forced from JWT
            resolved_by_name: body.resolved_by_name || null,
            resolved_at: new Date().toISOString(),
          };
          // Tenant-scope the PATCH WHERE — defense-in-depth on top
          // of the review-lookup tenant check above.
          const tenantClauseR = callerCompanyId
            ? `&company_id=eq.${callerCompanyId}`
            : `&created_by=eq.${encodeURIComponent(user.id)}`;
          const r = await fetch(base + "?id=eq." + body.id + tenantClauseR, {
            method: "PATCH",
            headers: { ...wHdr, Prefer: "return=minimal" },
            body: JSON.stringify(patch),
          });
          if (!r.ok) return json(r.status, { error: "Failed to resolve review." });

          await writeAuditLog({
            company_id: companyId,
            actor_id: user.id,
            actor_name: body.resolved_by_name || null,
            event_type: "review.resolve",
            entity_type: "review_requests",
            entity_id: body.id,
            payload: { applied_to: appliedTo, context: ctx, promoted_section: promotedSection },
          });

          return json(200, {
            success: true,
            applied_to: appliedTo,
            promoted_section: promotedSection,
          });
        }

        if (body.action === "dismiss") {
          if (!body.id) return json(400, { error: "id required" });
          // Tenant-scoped PATCH so cross-tenant dismissals can't
          // happen by passing another tenant's review id.
          const tenantClauseD = callerCompanyId
            ? `&company_id=eq.${callerCompanyId}`
            : `&created_by=eq.${encodeURIComponent(user.id)}`;
          const r = await fetch(base + "?id=eq." + body.id + tenantClauseD, {
            method: "PATCH",
            headers: { ...wHdr, Prefer: "return=minimal" },
            body: JSON.stringify({ status: "dismissed", resolved_at: new Date().toISOString() }),
          });
          return json(r.ok ? 200 : r.status, r.ok ? { success: true } : { error: "Failed to dismiss." });
        }

        return json(400, { error: "Unknown review action." });
      }
    }

    // ── Anthropic proxy for correction analysis ───────────────────────────
    // Mirrors triage.js's guards: auth required, model allowlist,
    // max_tokens cap. Earlier this endpoint was an unauthenticated
    // pass-through that accepted any body — meaning anyone with the
    // function URL could burn Anthropic budget on Opus calls with
    // 4096 max_tokens. The /triage proxy had been hardened against
    // this; /analyze was forgotten.
    if (path.includes("/analyze")) {
      const user = await verifyUser(token);
      if (!user) return json(401, { error: "Authentication required." });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return json(500, { error: "API key not configured." });

      const ALLOWED_ANALYZE_MODELS = new Set([
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
      ]);
      const ANALYZE_MAX_TOKENS_CAP = 1024;

      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch (e) { return json(400, { error: "Invalid JSON body." }); }

      if (!body.model || !ALLOWED_ANALYZE_MODELS.has(body.model)) {
        return json(400, { error: "Unsupported model for /analyze." });
      }
      if (typeof body.max_tokens !== "number" || body.max_tokens <= 0) {
        body.max_tokens = 200;
      }
      if (body.max_tokens > ANALYZE_MAX_TOKENS_CAP) {
        body.max_tokens = ANALYZE_MAX_TOKENS_CAP;
      }

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      return json(r.status, await r.text());
    }

    // ── Admin endpoints (v0.3.27) ──────────────────────────────────────
    //
    // All /admin/* paths require is_admin=true on the caller's profile.
    // /admin/settings and /admin/categories require is_super_user=true
    // additionally (super-user is the role-system configurator; admin
    // is just user management).
    //
    // Every admin endpoint resolves the caller's profile and refuses
    // immediately if the flag check fails. Tenant scoping flows through
    // company_id like every other read in this file — an admin can only
    // see/edit users and categories in their own tenant. Super-user
    // doesn't break tenant scoping; it just unlocks the configuration
    // endpoints WITHIN the caller's tenant. Cross-tenant admin lives in
    // Supabase Dashboard, not here.
    if (path.includes("/admin")) {
      const user = await verifyUser(token);
      if (!user) return json(401, { error: "Authentication required." });
      const callerProfile = await resolveProfile(user);
      if (!isAdmin(callerProfile)) {
        return json(403, { error: "Admin access required.", code: "admin_only" });
      }
      const callerCompanyId = callerProfile.company_id;

      // /admin/users — list, update role/flags, (later) invite.
      if (path.includes("/admin/users")) {
        if (method === "GET") {
          // List all users in caller's tenant. Joins profiles with
          // auth.users via the user_id is implicit (profiles.id ==
          // auth.users.id). We expose email by reading auth.users
          // through the admin REST endpoint with the service key.
          if (!callerCompanyId) {
            return json(400, { error: "Caller has no company_id; cannot list tenant users." });
          }
          // Get profile rows for the tenant
          const profilesRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?company_id=eq.${callerCompanyId}&select=id,full_name,role,is_admin,is_super_user,last_seen,created_at&order=created_at.asc`,
            { headers: writeHeaders() }
          );
          const profileRows = await profilesRes.json();
          if (!Array.isArray(profileRows)) {
            return json(500, { error: "Could not load profiles.", detail: profileRows });
          }
          // Fetch emails from auth.users via the Supabase Auth admin
          // REST endpoint. One call per user; small tenants only.
          // GET /auth/v1/admin/users?id=eq.<id> isn't a standard
          // endpoint, so we fetch the full list and filter — fine
          // for tenants with <100 users. Migrate to per-id lookups
          // when scaling up.
          const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
            headers: {
              "apikey": SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY,
              "Authorization": "Bearer " + (SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY),
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
              `${SUPABASE_URL}/rest/v1/profiles?id=eq.${body.user_id}&company_id=eq.${callerCompanyId}`,
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
      }

      // /admin/categories — list and update category_metadata.
      // Super-user only (admins manage users; super-user configures
      // the role system itself).
      if (path.includes("/admin/categories")) {
        if (!isSuperUser(callerProfile)) {
          return json(403, { error: "Super-user access required.", code: "super_user_only" });
        }
        if (!callerCompanyId) {
          return json(400, { error: "Caller has no company_id." });
        }
        if (method === "GET") {
          const r = await fetch(
            `${SUPABASE_URL}/rest/v1/category_metadata?company_id=eq.${callerCompanyId}&order=display_order.asc,category_name.asc`,
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
              `${SUPABASE_URL}/rest/v1/category_metadata?id=eq.${body.id}&company_id=eq.${callerCompanyId}`,
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
      }

      // /admin/settings — tenant-level config (handoff template).
      // Super-user only.
      if (path.includes("/admin/settings")) {
        if (!isSuperUser(callerProfile)) {
          return json(403, { error: "Super-user access required.", code: "super_user_only" });
        }
        if (!callerCompanyId) {
          return json(400, { error: "Caller has no company_id." });
        }
        if (method === "GET") {
          const r = await fetch(
            `${SUPABASE_URL}/rest/v1/companies?id=eq.${callerCompanyId}&select=id,name,non_clinical_handoff_template`,
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
              `${SUPABASE_URL}/rest/v1/companies?id=eq.${callerCompanyId}`,
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
      }

      return json(404, { error: "Unknown admin endpoint." });
    }

    // ── /profile — caller's own profile (any authenticated user) ─────
    // Used by the frontend on session init to pick up role/flags so the
    // UI gates can render correctly without a separate /admin/users
    // call (which would be rejected for non-admins).
    if (path.includes("/profile")) {
      const user = await verifyUser(token);
      if (!user) return json(401, { error: "Authentication required." });
      if (method === "GET") {
        const profile = await resolveProfile(user);
        if (!profile) return json(404, { error: "Profile not found." });
        return json(200, profile);
      }
    }

    // ── /handoff-template — caller's tenant handoff template ─────────
    // Read-only for everyone, edited only via /admin/settings. The
    // non-clinical Inquiry flow reads this to render the handoff card.
    if (path.includes("/handoff-template")) {
      const user = await verifyUser(token);
      if (!user) return json(401, { error: "Authentication required." });
      if (method === "GET") {
        const companyId = await resolveCompanyId(user);
        if (!companyId) return json(400, { error: "Caller has no company_id." });
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/companies?id=eq.${companyId}&select=non_clinical_handoff_template`,
          { headers: writeHeaders() }
        );
        return json(r.status, await r.text());
      }
    }

    // ── /categories — active category list for the caller's tenant ───
    // Reads category_metadata, filtered to is_active=true. Frontend
    // uses this to populate the picker (filtered by is_clinical based
    // on role) and to validate category names client-side.
    if (path.includes("/categories")) {
      const user = await verifyUser(token);
      if (!user) return json(401, { error: "Authentication required." });
      if (method === "GET") {
        const companyId = await resolveCompanyId(user);
        if (!companyId) return json(400, { error: "Caller has no company_id." });
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/category_metadata?company_id=eq.${companyId}&is_active=eq.true&order=display_order.asc,category_name.asc`,
          { headers: writeHeaders() }
        );
        return json(r.status, await r.text());
      }
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("kb.handler:", err.message);
    return json(500, { error: err.message });
  }
};
