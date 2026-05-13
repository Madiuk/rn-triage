// _lib/routes/analyze.js
//
// /analyze — Anthropic proxy for the correction analyzer (Haiku
// model). The frontend calls this from submitCorrection when staff
// sends a different response than the AI's draft; Haiku compares
// the two and writes a brief learning note.
//
// Mirrors triage.js's guards:
//   - Auth required (Supabase JWT).
//   - Model allowlist (Haiku + Sonnet only — no Opus from this
//     endpoint, the bill would be cruel for what's basically a
//     diff-summarization task).
//   - max_tokens cap at 1024.
//
// Earlier this was an unauthenticated pass-through that accepted
// any body — meaning anyone with the function URL could burn
// Anthropic budget on arbitrary calls. The /triage proxy was
// hardened against this; /analyze had been overlooked until
// v0.3.4.
//
// Extracted from kb.js inline handler (v0.4.0).
//
// TODO(pre-multi-tenant): per-caller rate limit. Same insider-threat
// shape as /triage but smaller blast radius (Haiku only, 1024 token
// cap). Defer until /triage rate limiting lands; this endpoint
// should get the same treatment in the same pass. See PLAN.md
// "Security backlog (deferred from v0.4.x audit)" and
// RELAI_VALIDATION_AUDIT.md §1.9.

const { json } = require("../supabase");
const { verifyUser, extractToken } = require("../auth");

const ALLOWED_ANALYZE_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);
const ANALYZE_MAX_TOKENS_CAP = 1024;

async function handle(event) {
  const token = extractToken(event);
  const user = await verifyUser(token);
  if (!user) return json(401, { error: "Authentication required." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: "API key not configured." });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Invalid JSON body." }); }

  if (!body.model || !ALLOWED_ANALYZE_MODELS.has(body.model)) {
    return json(400, { error: "Unsupported model for /analyze." });
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens <= 0) {
    body.max_tokens = 200;
  }
  if (body.max_tokens > ANALYZE_MAX_TOKENS_CAP) {
    body.max_tokens = ANALYZE_MAX_TOKENS_CAP;
  }

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

module.exports = { handle };
