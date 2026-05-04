exports.handler = async function (event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Supabase not configured." }) };
  }

  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Prefer": "return=representation",
  };

  const method = event.httpMethod;
  const path = event.path || "";

  try {
    // ── KB entries ────────────────────────────────────────────────────────────
    if (path.endsWith("/kb") || path.endsWith("/kb/")) {
      const base = SUPABASE_URL + "/rest/v1/kb_entries";
      if (method === "GET") {
        const res = await fetch(base + "?order=section,position", { headers });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
      }
      if (method === "POST") {
        const body = JSON.parse(event.body);
        await fetch(base + "?id=neq.00000000-0000-0000-0000-000000000000", { method: "DELETE", headers });
        if (body.entries && body.entries.length > 0) {
          const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(body.entries) });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
        }
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: "[]" };
      }
    }

    // ── Snippets ──────────────────────────────────────────────────────────────
    if (path.includes("/snippets")) {
      const base = SUPABASE_URL + "/rest/v1/snippets";
      if (method === "GET") {
        const res = await fetch(base + "?order=created_at.desc", { headers });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
      }
      if (method === "POST") {
        const body = JSON.parse(event.body);
        // Check if update (has id) or insert
        if (body.id) {
          const res = await fetch(base + "?id=eq." + body.id, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ title: body.title, content: body.content, nurse_name: body.nurse_name, updated_at: new Date().toISOString() })
          });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
        }
        const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
      }
      if (method === "DELETE") {
        const body = JSON.parse(event.body);
        const res = await fetch(base + "?id=eq." + body.id, { method: "DELETE", headers });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: "{}" };
      }
    }

    // ── Query history ─────────────────────────────────────────────────────────
    if (path.includes("/history")) {
      const base = SUPABASE_URL + "/rest/v1/query_history";
      if (method === "GET") {
        const res = await fetch(base + "?order=created_at.desc&limit=200", { headers });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
      }
      if (method === "POST") {
        const body = JSON.parse(event.body);
        // Check if urgency override update
        if (body.action === "update_urgency") {
          const res = await fetch(base + "?id=eq." + body.id, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ urgency_override: body.urgency_override })
          });
          return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
        }
        // Insert new record
        const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: await res.text() };
      }
    }

    return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
