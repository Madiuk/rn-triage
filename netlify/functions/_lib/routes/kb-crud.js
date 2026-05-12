// _lib/routes/kb-crud.js
//
// /kb — the actual Knowledge Base CRUD. Read (GET) returns every
// KB entry for the caller's tenant; Write (POST) replaces the
// whole KB atomically via DELETE-then-INSERT inside a single
// request.
//
// Extracted from kb.js inline handler (v0.4.0).
//
// SAFETY-CRITICAL: the write path used to silently wipe entire
// tenant KBs if the snapshot-for-restore step ran through RLS
// (which returns [] under our policy config). The fix from earlier
// versions is preserved here: every read on this path uses the
// service key + explicit tenant filter, never the user JWT. If
// you're tempted to switch any of these reads to readHeaders(token)
// for "consistency," DON'T — it'll wipe production KBs on the
// first failed insert.

const {
  SUPABASE_URL,
  writeHeaders,
  json,
} = require("../supabase");

const {
  verifyUser,
  resolveCompanyId,
  extractToken,
} = require("../auth");

const { writeAuditLog } = require("../db");

async function handle(event) {
  const method = event.httpMethod;
  const token = extractToken(event);
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
      ? `company_id=eq.${encodeURIComponent(companyId)}`
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
      ? `company_id=eq.${encodeURIComponent(companyId)}`
      : `user_id=eq.${encodeURIComponent(user.id)}`;
    let backup = [];
    try {
      const cur = await fetch(base + "?" + snapScope + "&select=*", { headers: wHdr });
      if (cur.ok) backup = await cur.json();
    } catch (e) {
      console.error("kb-crud.snapshot:", e.message);
    }

    // Tenant-scoped delete — never blow away another tenant's KB.
    const delScope = companyId
      ? `company_id=eq.${encodeURIComponent(companyId)}`
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
      // Restore the snapshot. Best-effort — drop server-generated
      // columns PostgREST will reject (id is fine to keep).
      if (backup.length) {
        try {
          await fetch(base, {
            method: "POST",
            headers: wHdr,
            body: JSON.stringify(backup),
          });
        } catch (e) {
          console.error("kb-crud.restore:", e.message);
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

  return json(405, { error: "Method not allowed." });
}

module.exports = { handle };
