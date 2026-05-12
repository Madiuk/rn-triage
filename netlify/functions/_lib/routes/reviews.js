// _lib/routes/reviews.js
//
// /reviews — review_requests CRUD and the active learning loop.
// Three POST actions:
//   - create:  any authenticated caller can save a review_request
//              (the AI emits one whenever confidence < 0.75 on a
//              clinical decision; runTriage persists it).
//   - resolve: clinical-only on clinical-originating reviews
//              (role gate via permissions.canResolveReview). When
//              resolved with context=kb_gap or context=protocol,
//              the answer is promoted into kb_entries.
//   - dismiss: tenant-scoped, sets status=dismissed.
//
// Extracted from kb.js inline handler (v0.4.0). The
// promoteReviewToKB helper that used to live at the top of kb.js
// moves here — it's only called from the resolve handler in this
// file, so it belongs in this module.

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
  rowIsClinical,
  canResolveReview,
} = require("../permissions");

const {
  fetchRowInTenant,
  writeAuditLog,
} = require("../db");

// Promote a resolved review_request into a kb_entries row. Returns
// the section it was filed under ('notes' | 'protocols'), or null
// on failure / non-promotable context.
//
// CRITICAL: this function's failure mode (returning null when the
// caller expected promotion) is what produces the 'kb_failed'
// applied_to status in the resolve handler. Earlier code collapsed
// success-vs-failure into a single 'kb' status, masking real KB
// drift. The three-state model — kb / kb_failed / confirmation —
// is what surfaces broken promotions to the calling staff so they
// know their answer didn't reach the KB.
async function promoteReviewToKB({ companyId, context, question, answer, resolvedByName }) {
  // Map review context to KB section. kb_gap → notes (general
  // rules), protocol → protocols. Other contexts don't auto-promote.
  const section = context === "kb_gap" ? "notes" : context === "protocol" ? "protocols" : null;
  if (!section || !answer) return null;

  // Compute a stable position (append to end of section). Service
  // key — earlier code used readHeaders() with no token (anon
  // access), which under RLS would return [] and pile every
  // promoted entry at position 0. Real KB drift over time.
  let position = 0;
  try {
    const posRes = await fetch(
      `${SUPABASE_URL}/rest/v1/kb_entries?company_id=eq.${encodeURIComponent(companyId)}&section=eq.${section}&select=position&order=position.desc&limit=1`,
      { headers: writeHeaders() }
    );
    const rows = await posRes.json();
    if (Array.isArray(rows) && rows[0] && typeof rows[0].position === "number") {
      position = rows[0].position + 1;
    }
  } catch (e) {
    console.error("reviews.promotePosition:", e.message);
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
      console.error("reviews.promoteReviewToKB:", "insert failed", r.status);
      return null;
    }
    return section;
  } catch (e) {
    console.error("reviews.promoteReviewToKB:", e.message);
    return null;
  }
}

async function handle(event) {
  const method = event.httpMethod;
  const token = extractToken(event);
  const base = SUPABASE_URL + "/rest/v1/review_requests";

  if (method === "GET") {
    // Tenant-scope by company_id, service key, RLS-independent.
    // CRITICAL: this endpoint feeds the Pending Review Items badge
    // AND the active learning loop (resolved reviews → KB inserts).
    // If RLS denied SELECT here — which is what would happen on a
    // fresh deploy from migrations alone — every AI-flagged
    // uncertainty would be invisible to staff and the KB would
    // never auto-improve from staff answers.
    const user = await verifyUser(token);
    if (!user) return json(401, { error: "Authentication required." });
    const companyId = await resolveCompanyId(user);
    const scope = companyId
      ? `company_id=eq.${encodeURIComponent(companyId)}`
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
    // Resolve full profile so we can role-gate resolve. Create is
    // open to any authenticated user — the AI emits review_request
    // from any triage and we want whoever ran the triage to be
    // able to persist it.
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
      // company_id. Service key — earlier code used readHeaders(token)
      // here, which means RLS could silently return [] and `review`
      // would be null, breaking the entire active learning loop
      // silently.
      let review = null;
      try {
        const lookup = await fetch(base + "?id=eq." + encodeURIComponent(body.id) + "&select=*", { headers: writeHeaders() });
        const arr = await lookup.json();
        if (Array.isArray(arr) && arr[0]) review = arr[0];
      } catch (e) { console.error("reviews.reviewLookup:", e.message); }

      if (!review) return json(404, { error: "Review not found." });

      // Tenant check: caller's company_id must match the review
      // row's company_id. Without this, a user with any valid
      // session could resolve another tenant's reviews —
      // injecting their answer into the wrong tenant's KB.
      if (callerCompanyId && review.company_id && review.company_id !== callerCompanyId) {
        return json(403, { error: "Cross-tenant review resolve refused." });
      }

      // ROLE GATE: non-clinical staff cannot resolve reviews
      // originating from clinical-tier triages. Delegated to
      // permissions.canResolveReview which encapsulates the rule.
      if (review.triage_id) {
        const originTriage = await fetchRowInTenant(review.triage_id, callerCompanyId);
        if (!canResolveReview(callerProfile, originTriage)) {
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

      // Three distinct outcomes — DON'T collapse them:
      //   - 'kb':           context was kb-eligible AND promotion succeeded.
      //   - 'kb_failed':    context was kb-eligible BUT promotion failed
      //                     (network blip, schema constraint, etc.).
      //   - 'confirmation': context wasn't kb-eligible (routing,
      //                     severity, category, general).
      let appliedTo = "confirmation";
      let promotedSection = null;
      if (companyId && (ctx === "kb_gap" || ctx === "protocol")) {
        promotedSection = await promoteReviewToKB({
          companyId,
          context: ctx,
          question: body.question || review.question || "",
          answer: body.answer || "",
          resolvedByName: body.resolved_by_name || null,
        });
        if (promotedSection) {
          appliedTo = "kb";
        } else {
          appliedTo = "kb_failed";
          console.error("reviews.resolveReview.promotionFailed:", { reviewId: body.id, companyId, context: ctx });
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
        ? `&company_id=eq.${encodeURIComponent(callerCompanyId)}`
        : `&created_by=eq.${encodeURIComponent(user.id)}`;
      const r = await fetch(base + "?id=eq." + encodeURIComponent(body.id) + tenantClauseR, {
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
        ? `&company_id=eq.${encodeURIComponent(callerCompanyId)}`
        : `&created_by=eq.${encodeURIComponent(user.id)}`;
      const r = await fetch(base + "?id=eq." + encodeURIComponent(body.id) + tenantClauseD, {
        method: "PATCH",
        headers: { ...wHdr, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "dismissed", resolved_at: new Date().toISOString() }),
      });
      return json(r.ok ? 200 : r.status, r.ok ? { success: true } : { error: "Failed to dismiss." });
    }

    return json(400, { error: "Unknown review action." });
  }

  return json(405, { error: "Method not allowed." });
}

module.exports = {
  handle,
  // Exported for tests / migration scripts that want to replay a
  // promotion outside the request flow.
  promoteReviewToKB,
};
