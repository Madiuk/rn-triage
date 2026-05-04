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
  const base = SUPABASE_URL + "/rest/v1/kb_entries";

  try {
    if (method === "GET") {
      const res = await fetch(base + "?order=section,position", { headers });
      const data = await res.json();
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
    }

    if (method === "POST") {
      const body = JSON.parse(event.body);
      // Bulk replace: delete all then insert new
      await fetch(base + "?id=neq.00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
        headers,
      });
      if (body.entries && body.entries.length > 0) {
        const res = await fetch(base, {
          method: "POST",
          headers,
          body: JSON.stringify(body.entries),
        });
        const data = await res.json();
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
      }
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify([]) };
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
