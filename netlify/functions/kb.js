exports.handler = async function (event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return { statusCode: 500, body: JSON.stringify({ error: "Supabase not configured." }) };

  const h = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Prefer": "return=representation",
  };
  const method = event.httpMethod;
  const path = event.path || "";

  try {
    // KB entries
    if (path.endsWith("/kb") || path.endsWith("/kb/")) {
      const base = SUPABASE_URL + "/rest/v1/kb_entries";
      if (method === "GET") {
        const r = await fetch(base + "?order=section,position", { headers: h });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
      }
      if (method === "POST") {
        const body = JSON.parse(event.body);
        await fetch(base + "?id=neq.00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: h });
        if (body.entries && body.entries.length > 0) {
          const r = await fetch(base, { method: "POST", headers: h, body: JSON.stringify(body.entries) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
        }
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: "[]" };
      }
    }

    // Query history
    if (path.includes("/history")) {
      const base = SUPABASE_URL + "/rest/v1/query_history";
      if (method === "GET") {
        const r = await fetch(
          base + "?or=(actual_response_sent.not.is.null,correction_note.not.is.null)&order=created_at.desc&limit=100",
          { headers: h }
        );
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
      }
      if (method === "POST") {
        const body = JSON.parse(event.body);

        if (body.action === "update_urgency") {
          const r = await fetch(base + "?id=eq." + body.id, { method: "PATCH", headers: h, body: JSON.stringify({ urgency_override: body.urgency_override }) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
        }
        if (body.action === "update_category") {
          const r = await fetch(base + "?id=eq." + body.id, { method: "PATCH", headers: h, body: JSON.stringify({ clinical_category: body.category }) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
        }
        if (body.action === "downvote") {
          const r = await fetch(base + "?id=eq." + body.id, { method: "PATCH", headers: h, body: JSON.stringify({ downvoted: true, downvote_reason: body.reason || "" }) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
        }
        if (body.action === "upvote") {
          const r = await fetch(base + "?id=eq." + body.id, { method: "PATCH", headers: h, body: JSON.stringify({ upvoted: true, upvote_reason: body.reason || "" }) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
        }
        if (body.action === "save_actual") {
          const r = await fetch(base + "?id=eq." + body.id, { method: "PATCH", headers: h, body: JSON.stringify({ actual_response_sent: body.actual_response, correction_note: body.correction_note || "" }) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
        }
        // Insert
        const r = await fetch(base, { method: "POST", headers: h, body: JSON.stringify(body) });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await r.text() };
      }
    }

    // Anthropic proxy for correction analysis
    if (path.includes("/analyze")) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "API key not configured." }) };
      const body = JSON.parse(event.body);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: await r.text() };
    }

    return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
