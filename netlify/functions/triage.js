// Relai — Anthropic API proxy for clinical triage.
// Validates the caller's session, the model, and the max_tokens cap so
// only authenticated staff can drive Anthropic spend. Forwards
// prompt-cache control to Anthropic and decorates the response with a
// `_relai` telemetry envelope (latency, model, cost, usage). The
// frontend persists that envelope onto the query_history row so we can
// measure quality / cost / cache-hit-rate over time.

const { computeTriageCost } = require("../../data/triage-lib");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
]);
const MAX_TOKENS_CAP = 4096;

// Verify the caller has a valid Supabase session. Without this guard,
// anyone with the function URL can hit /triage with arbitrary system
// prompts and max_tokens — the only constraint was the model
// allowlist and token cap, both of which were budget-burn vectors on
// their own (4096 tokens × Opus rate × unlimited concurrent calls).
async function verifyCaller(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    console.error("triage.verifyCaller:", e.message);
    return null;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const token = (event.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const user = await verifyCaller(token);
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Authentication required." }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key not configured on server." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  if (!body.model || !ALLOWED_MODELS.has(body.model)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Unsupported model." }) };
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens <= 0) {
    body.max_tokens = 1024;
  }
  if (body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = MAX_TOKENS_CAP;
  }

  const startedAt = Date.now();
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    // On non-2xx we still want the client to see the upstream error, but
    // we shouldn't try to enrich a response shape we don't trust. Pass
    // it through verbatim.
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { "Content-Type": "application/json" },
        body: text,
      };
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      // Anthropic returned 200 but unparseable body — surface as 502.
      console.error("triage.parse:", e.message);
      return { statusCode: 502, body: JSON.stringify({ error: "Upstream returned malformed JSON." }) };
    }

    parsed._relai = {
      model: body.model,
      latency_ms: latencyMs,
      cost_usd: computeTriageCost(body.model, parsed.usage),
      // Echo the usage block at top level for convenience — clients
      // shouldn't have to know that Anthropic nests it.
      usage: parsed.usage || null,
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    console.error("triage.proxy:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
