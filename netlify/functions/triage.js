// Relai — Anthropic API proxy for clinical triage.
// Validates the model + max_tokens cap so a misbehaving client can't run up
// the bill, forwards prompt-cache control to Anthropic, and decorates the
// response with a `_relai` telemetry envelope (latency, model, cost,
// usage). The frontend persists that envelope onto the query_history row
// so we can measure quality / cost / cache-hit-rate over time.

const { computeTriageCost } = require("../../data/triage-lib");

const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
]);
const MAX_TOKENS_CAP = 4096;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
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
