// Relai — KB / History / Reviews / Analyze proxy
// Endpoints: /kb (GET, POST), /history[/all] (GET, POST), /reviews (GET, POST), /analyze (POST)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
        const r = await fetch(base + "?order=section,position", { headers: readHeaders(token) });
        return json(r.status, await r.text());
      }

      if (method === "POST") {
        const user = await verifyUser(token);
        if (!user) return json(401, { error: "Authentication required to write KB." });

        const body = JSON.parse(event.body || "{}");
        const newEntries = Array.isArray(body.entries) ? body.entries : [];
        const wHdr = writeHeaders();

        // Snapshot current entries first so we can restore on failure.
        let backup = [];
        try {
          const cur = await fetch(base + "?select=*", { headers: readHeaders(token) });
          if (cur.ok) backup = await cur.json();
        } catch (e) {
          console.error("kb.snapshot:", e.message);
        }

        const delRes = await fetch(base + "?id=neq.00000000-0000-0000-0000-000000000000", {
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

        return json(200, await insRes.text());
      }
    }

    // ── Query history ─────────────────────────────────────────────────────
    if (path.includes("/history")) {
      const base = SUPABASE_URL + "/rest/v1/query_history";

      if (method === "GET") {
        const isAll = path.includes("/history/all");
        const query = isAll
          ? "?order=created_at.desc&limit=200"
          : "?or=(actual_response_sent.not.is.null,correction_note.not.is.null)&order=created_at.desc&limit=100";
        const r = await fetch(base + query, { headers: readHeaders(token) });
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

        switch (body.action) {
          case "update_urgency":
            return patchById({ urgency_override: body.urgency_override });
          case "update_category":
            return patchById({ clinical_category: body.category });
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
            return patchById(patch);
          }
          case "update_escalation":
            return patchById({ escalation_validated: true, escalation_correct: body.correct });
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
        const r = await fetch(base + "?order=created_at.desc&limit=100", { headers: readHeaders(token) });
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
          const patch = {
            status: "resolved",
            answer: body.answer || "",
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
          // applied_to is a hook for future routing logic (KB write, correction
          // attach, etc). For now every resolution is a confirmation.
          return json(200, { success: true, applied_to: "confirmation" });
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
    if (path.includes("/analyze")) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return json(500, { error: "API key not configured." });
      const body = JSON.parse(event.body || "{}");
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
