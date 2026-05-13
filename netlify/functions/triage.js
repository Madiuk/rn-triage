// Relai — Anthropic API proxy for clinical triage.
// Validates the caller's session, the model, and the max_tokens cap so
// only authenticated staff can drive Anthropic spend. Forwards
// prompt-cache control to Anthropic and decorates the response with a
// `_relai` telemetry envelope (latency, model, cost, usage). The
// frontend persists that envelope onto the query_history row so we can
// measure quality / cost / cache-hit-rate over time.
//
// TODO(pre-multi-tenant): validate body.system + body.messages shape.
// Today an authenticated caller can send any system prompt + any
// messages payload — the model allowlist and max_tokens cap are the
// only constraints. A signed-in user can replace the persona, swap
// to Opus, and drive Anthropic spend; the frontend assembles
// BASE_PROMPT + KB as the system block but the server doesn't enforce
// that contract. Single-tenant trial means insider-only threat
// bounded by ANTHROPIC_API_KEY budget alerts. Becomes urgent at
// multi-tenant rollout OR on any cost anomaly. Fix shape: hash-check
// body.system against the expected BASE_PROMPT + KB block, bound
// body.messages length and shape. See PLAN.md "Security backlog
// (deferred from v0.4.x audit)" and RELAI_VALIDATION_AUDIT.md §1.8.
//
// TODO(pre-auto-send): the AI's structured output downstream
// (clinical_routing_level, urgency, ai_confidence, draft_response)
// is trusted as written. Prompt injection in patient_message can
// produce semantically-wrong-but-syntactically-valid output — e.g.,
// 'none' routing + 0.95 confidence + a soothing draft for a
// clinically severe message. The CHECK constraints in migrations
// 0012-0014 catch shape drift but NOT semantic correctness. Today
// the patient-safety backstop is the staff member who reviews the
// draft before sending. The moment "send" becomes auto-send, this
// becomes urgent: add a second-pass Haiku classifier checking for
// routing/severity/confidence mismatches against the message AND
// server-side enum + range revalidation mirroring the DB CHECKs.
// Brad's call on the trigger — v0.4.1 era he noted the AI is "so
// young it's making the same mistakes I am not using for patient
// replies." See PLAN.md "Security backlog" and
// RELAI_VALIDATION_AUDIT.md §4.1.

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
