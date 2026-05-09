// Relai — Anthropic API proxy for clinical triage.
// Validates the model + max_tokens cap so a misbehaving client can't run up
// the bill, and forwards prompt-cache control to Anthropic.

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

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json" },
      body: await response.text(),
    };
  } catch (err) {
    console.error("triage.proxy:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
