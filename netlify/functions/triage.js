// Care Station — Anthropic API proxy for clinical triage.
//
// HTTP wrapper around netlify/functions/_lib/triage-core.js. This
// file owns:
//
//   1. JWT auth (verifyCaller)
//   2. Request-shape validation (model allowlist, max_tokens cap,
//      message shape, body.system rejection)
//   3. Resolving the caller's tenant (resolveCompanyId)
//   4. HTTP response shaping (status codes, error envelope,
//      verbatim pass-through of upstream Anthropic errors)
//
// The actual triage orchestration — KB load, history load, system
// assembly, Anthropic call, parse, normalize, and the multi-layer
// safety pipeline (parse → strict validation → tripwire → Haiku
// second-pass) — lives in _lib/triage-core.js so the worker can
// invoke the same code path without going through this HTTP layer.
// Behavior must remain identical to pre-refactor for all existing
// /triage callers.
//
// Strict server-side system assembly (#2 contract lockdown complete).
// The proxy is the only source of truth for what the model sees as
// `system`. Callers MUST NOT supply body.system; triage-core
// assembles BASE_PROMPT + tenant KB + recent staff examples
// server-side. body.messages is validated to exactly one
// { role:"user", content:string } with content <= 8192 chars.
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

const { resolveCompanyId } = require("./_lib/auth");
const { runTriage, ALLOWED_MODELS, MAX_TOKENS_CAP } = require("./_lib/triage-core");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Per-message content cap. Patient messages in production are typically
// under 1KB; 8KB is generous for the longest realistic clinical
// narrative while bounding worst-case Anthropic spend per call.
const MESSAGE_CONTENT_MAX = 8192;

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

  // Message shape validation. Triage is a one-shot classification: a
  // single user message in, a single JSON classification out. Multi-
  // turn conversations or system-role messages here are either a
  // client bug or a budget-burn vector — reject both. The content
  // cap bounds worst-case Anthropic spend per call.
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    return { statusCode: 400, body: JSON.stringify({ error: "Triage requires exactly one message." }) };
  }
  const m = body.messages[0];
  if (!m || m.role !== "user" || typeof m.content !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: 'Message must be { role: "user", content: string }.' }) };
  }
  if (m.content.length > MESSAGE_CONTENT_MAX) {
    return { statusCode: 400, body: JSON.stringify({ error: "Message content exceeds " + MESSAGE_CONTENT_MAX + " characters." }) };
  }

  // Strict: callers MUST NOT supply body.system. The proxy is the
  // only place that chooses the persona, the KB, and the few-shot
  // examples. A client-supplied system would let any authenticated
  // user replace the persona, pin a different KB, or hand-craft
  // examples — exactly the threat #2 closed.
  if (body.system !== undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: "body.system is not accepted; the proxy assembles the system from server-side state." }) };
  }

  const companyId = await resolveCompanyId(user);
  if (!companyId) {
    return { statusCode: 500, body: JSON.stringify({ error: "Caller has no resolved company_id; cannot assemble triage prompt." }) };
  }

  const result = await runTriage({
    companyId: companyId,
    patientMessage: m.content,
    model: body.model,
    maxTokens: body.max_tokens,
    apiKey: apiKey,
  });

  if (!result.ok) {
    // Upstream Anthropic errors get their body passed through verbatim
    // (via result.raw) so the client sees the actual upstream message.
    // Our own helper-level errors get a JSON envelope.
    return {
      statusCode: result.statusCode || 500,
      headers: { "Content-Type": "application/json" },
      body: result.raw != null ? result.raw : JSON.stringify({ error: result.error }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result.parsed),
  };
};
