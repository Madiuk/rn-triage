// Relai — KB / History / Reviews / Analyze proxy
// Endpoints:
//   /kb                  (GET, POST)
//   /history             (GET, POST)
//   /history/all         (GET)
//   /history/stats       (GET) — per-user today/week/total counts
//   /history/cost        (GET) — last-N-days spend, model split, cache hit rate
//   /history/quality     (GET) — override / correction / confidence trends
//   /reviews             (GET, POST)
//   /analyze             (POST)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const { aggregateCostRows, aggregateQualityRows } = require("./_lib/history-aggregations");

// PostgREST-style headers. Uses service key when available so RLS-protected
// writes go through; reads use the user's bearer token when present so RLS
// company-scoping still applies.
function readHeaders(token) {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": "Bearer " + (token || SUPABASE_ANON_KEY),
  };
}
function writeHeaders() {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  return {
    "Content-Type": "application/json",
    "apikey": key,
    "Authorization": "Bearer " + key,
    "Prefer": "return=representation",
  };
}

async function verifyUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: readHeaders(token) });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    console.error("kb.verifyUser:", e.message);
    return null;
  }
}

// Look up the verified user's company_id from the profiles table using
// the service key. Returns null if no company_id is set on the row.
//
// This is the keystone for tenant-scoped reads. All read endpoints in
// this file route through here so they can scope queries by
// company_id explicitly — independent of whatever RLS policies happen
// (or don't) to be configured on the tables. The migrations enable RLS
// on every tenant table but never declare any SELECT policies, which
// means user-JWT reads return zero rows by default. Service-key +
// explicit company_id filter is what makes the read path actually
// work and not depend on Supabase-dashboard configuration drift.
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
    console.error("kb.resolveCompanyId:", e.message);
    return null;
  }
}

// Best-effort append to public.audit_log. Never throws — audit failures
// must not block real operations.
async function writeAuditLog(entry) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/audit_log", {
      method: "POST",
      headers: { ...writeHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error("kb.writeAuditLog:", e.message);
  }
}

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

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

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

        if (!newEntries.length) return json(200, "[]");

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

        const patchById = async (patch) => {
          const r = await fetch(base + "?id=eq." + body.id, {
            method: "PATCH",
            headers: wHdr,
            body: JSON.stringify(patch),
          });
          return json(r.status, await r.text());
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
            const patch = { clinical_category: body.category || null };
            if (Array.isArray(body.non_clinical_items)) {
              patch.non_clinical_items = body.non_clinical_items;
            }
            if (typeof body.non_clinical_flag === "boolean") {
              patch.non_clinical_flag = body.non_clinical_flag;
            }
            return patchById(patch);
          }
          case "downvote":
            return patchById({ downvoted: true, downvote_reason: body.reason || "" });
          case "upvote":
            return patchById({ upvoted: true, upvote_reason: body.reason || "" });
          case "save_actual": {
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
          case "delete_correction":
            return patchById({ actual_response_sent: null, correction_note: null });
          default: {
            // Insert
            const r = await fetch(base, { method: "POST", headers: wHdr, body: JSON.stringify(body) });
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

        if (body.action === "create") {
          const record = {
            triage_id: body.triage_id || null,
            company_id: body.company_id || null,
            created_by: body.created_by || user.id,
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

          const ctx = body.context || (review && review.context) || "general";
          const companyId = (review && review.company_id) || body.company_id || null;

          // Decide what to do with the answer. kb_gap / protocol promote
          // into kb_entries; other contexts are saved on the review row only.
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
            if (promotedSection) appliedTo = "kb";
          }

          const patch = {
            status: "resolved",
            answer: body.answer || "",
            applied_to: appliedTo,
            resolved_by: body.resolved_by || user.id,
            resolved_by_name: body.resolved_by_name || null,
            resolved_at: new Date().toISOString(),
          };
          const r = await fetch(base + "?id=eq." + body.id, {
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
          const r = await fetch(base + "?id=eq." + body.id, {
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

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("kb.handler:", err.message);
    return json(500, { error: err.message });
  }
};
