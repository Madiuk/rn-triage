// Care Station — Anthropic API proxy for clinical triage.
// Validates the caller's session, the model, and the max_tokens cap so
// only authenticated staff can drive Anthropic spend. Forwards
// prompt-cache control to Anthropic and decorates the response with a
// `_relai` telemetry envelope (latency, model, cost, usage). The
// frontend persists that envelope onto the query_history row so we can
// measure quality / cost / cache-hit-rate over time.
//
// Strict server-side system assembly (#2 contract lockdown complete).
// The proxy is the only source of truth for what the model sees as
// `system`. Callers MUST NOT supply body.system; the proxy assembles
// BASE_PROMPT + tenant KB + recent staff examples server-side using
// the helpers in data/triage-lib.js. body.messages is validated to
// exactly one { role:"user", content:string } with content <= 8192
// chars.
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

const {
  computeTriageCost,
  parseTriageJSON,
  normalizeTriageOutput,
  diffNormalization,
  buildFullKB,
  buildStaffExamplesBlock,
  scanTripwires,
  validateTriageOutput,
  applyTripwireOverride,
} = require("../../data/triage-lib");

const { BASE_PROMPT } = require("../../data/base-prompt");
const { RELAI_DEFAULTS } = require("../../data/defaults");
const { resolveCompanyId } = require("./_lib/auth");
const { writeHeaders } = require("./_lib/supabase");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
]);
const MAX_TOKENS_CAP = 4096;
// Per-message content cap. Patient messages in production are typically
// under 1KB; 8KB is generous for the longest realistic clinical
// narrative while bounding worst-case Anthropic spend per call.
const MESSAGE_CONTENT_MAX = 8192;

// Load the caller's tenant KB rows directly from Supabase using the
// service key. Mirrors the GET path in _lib/routes/kb-crud.js — same
// filter (company_id), same ordering — so the rows the proxy sees
// are identical to what /kb returns to the browser. Returns null on
// fetch error (caller decides whether to fail-fast or degrade).
async function loadKBForTenant(companyId) {
  if (!companyId) return null;
  try {
    // PostgREST column alias: `text:content` returns the `content`
    // column under the field name `text`, matching the in-memory
    // shape buildFullKB / formatKBSection expect. A bare `text`
    // here would 400 ("column kb_entries.text does not exist")
    // and collapse to "KB unavailable for this tenant."
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/kb_entries?company_id=eq.${encodeURIComponent(companyId)}` +
        `&order=section,position&select=section,name,text:content`,
      { headers: writeHeaders() }
    );
    if (!r.ok) {
      // Distinguish a Supabase/PostgREST error from a tenant that
      // genuinely has zero KB rows. Without this log both states
      // were indistinguishable in production.
      let detail = "";
      try { detail = (await r.text()).slice(0, 200); } catch (e) { /* ignore */ }
      console.error("triage.loadKBForTenant: kb_entries fetch failed", r.status, detail);
      return null;
    }
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    console.error("triage.loadKBForTenant:", e.message);
    return null;
  }
}

// Load recent history rows for the few-shot staff examples block.
// Mirrors the GET path in _lib/routes/history.js (corrections feed)
// so the input to buildStaffExamplesBlock matches what app.js
// previously assembled client-side. Examples are quality, not
// safety — a fetch error degrades silently (no examples block) so
// triage doesn't hard-fail on a transient history-table blip.
async function loadHistoryForExamples(companyId) {
  if (!companyId) return [];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history?company_id=eq.${encodeURIComponent(companyId)}` +
        `&or=(actual_response_sent.not.is.null,correction_note.not.is.null)` +
        `&order=created_at.desc&limit=100`,
      { headers: writeHeaders() }
    );
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error("triage.loadHistoryForExamples:", e.message);
    return [];
  }
}

// Second-pass clinical sanity check using Haiku. Asks "given this
// patient message and this AI triage, do they agree?" Output is a
// single word — agree | disagree | unsure. Anything other than
// 'agree' routes the message to human review. This layer only
// activates when RELAI_SECOND_PASS_HAIKU=true. Today the human
// reviewer IS the backstop (staff edits the draft before sending);
// the second-pass is wired now so that when auto-send arrives, the
// safety net is one env-var flip away rather than a code change
// under deadline pressure.
//
// Conservative bias: the prompt instructs Haiku to output 'unsure'
// rather than 'agree' when borderline. False positives (routing a
// legit routine message to review) cost staff ~30 seconds; false
// negatives (passing a clinical mismatch as agreed) cost patient
// safety. The cost of one Haiku call is ~$0.0005 — negligible
// against the alternative.
const HAIKU_SECOND_PASS_SYSTEM =
  'You are a clinical safety reviewer. Given a patient message and an AI triage classification, decide if they agree clinically. Output ONLY one lowercase word: agree, disagree, or unsure.\n' +
  '\n' +
  '- "agree" = the routing/urgency makes clinical sense for the message\n' +
  '- "disagree" = clearly wrong (e.g., chest pain rated as routine, suicidal ideation rated as non-clinical)\n' +
  '- "unsure" = borderline or ambiguous; not enough information to confirm agreement\n' +
  '\n' +
  'Be conservative: when in doubt, output "unsure". The cost of routing one extra message to human review is far lower than the cost of missing a clinical mismatch.';

async function haikuSecondPass(patientMessage, triageOutput, apiKey) {
  const userMessage =
    'PATIENT MESSAGE:\n' + (patientMessage || '(empty)') + '\n\n' +
    'AI TRIAGE:\n' +
    '- urgency: ' + (triageOutput.urgency || 'unknown') + '\n' +
    '- clinical_routing_level: ' + (triageOutput.clinical_routing_level || 'unknown') + '\n' +
    '- clinical_category: ' + (triageOutput.clinical_category || 'unknown') + '\n' +
    '- ai_confidence: ' + (triageOutput.ai_confidence != null ? triageOutput.ai_confidence : 'unknown') + '\n' +
    '\n' +
    'Do these agree clinically?';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8,
        system: HAIKU_SECOND_PASS_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!r.ok) {
      // Fail open to 'unsure' — a transient Haiku error must not
      // silently approve a triage that should have been reviewed.
      return { verdict: 'unsure', reason: 'haiku_http_' + r.status, cost_usd: null };
    }
    const body = await r.json();
    const text = ((body.content || [])[0] || {}).text || '';
    const verdict = (/agree/i.test(text) && !/disagree/i.test(text)) ? 'agree'
                   : /disagree/i.test(text) ? 'disagree' : 'unsure';
    const cost_usd = computeTriageCost('claude-haiku-4-5', body.usage);
    return { verdict: verdict, raw: text.trim(), cost_usd: cost_usd, usage: body.usage || null };
  } catch (e) {
    console.error('triage.haikuSecondPass:', e.message);
    return { verdict: 'unsure', reason: 'haiku_fetch_error', cost_usd: null };
  }
}

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
  {
    const m = body.messages[0];
    if (!m || m.role !== "user" || typeof m.content !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: 'Message must be { role: "user", content: string }.' }) };
    }
    if (m.content.length > MESSAGE_CONTENT_MAX) {
      return { statusCode: 400, body: JSON.stringify({ error: "Message content exceeds " + MESSAGE_CONTENT_MAX + " characters." }) };
    }
  }

  // Strict: callers MUST NOT supply body.system. The proxy is the
  // only place that chooses the persona, the KB, and the few-shot
  // examples. A client-supplied system would let any authenticated
  // user replace the persona, pin a different KB, or hand-craft
  // examples — exactly the threat #2 closed.
  if (body.system !== undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: "body.system is not accepted; the proxy assembles the system from server-side state." }) };
  }

  // Assemble system from BASE_PROMPT + tenant KB + recent staff
  // examples. KB is safety-critical: empty/failed KB load → 500,
  // not "trust the AI to triage without rules." History is
  // quality-critical only: failed load → empty examples block.
  {
    const companyId = await resolveCompanyId(user);
    if (!companyId) {
      return { statusCode: 500, body: JSON.stringify({ error: "Caller has no resolved company_id; cannot assemble triage prompt." }) };
    }
    const kbRows = await loadKBForTenant(companyId);
    if (!kbRows || !kbRows.length) {
      return { statusCode: 500, body: JSON.stringify({ error: "KB unavailable for this tenant." }) };
    }
    const historyRows = await loadHistoryForExamples(companyId);
    const kbBlockText = buildFullKB(kbRows, RELAI_DEFAULTS.kb_sections);
    const examplesBlockText = buildStaffExamplesBlock(historyRows);
    const systemBlocks = [
      { type: "text", text: BASE_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: kbBlockText, cache_control: { type: "ephemeral" } },
    ];
    if (examplesBlockText) {
      // Intentionally uncached — examples shift as corrections
      // accumulate, and caching would poison the cache prefix for
      // every subsequent triage. Cost: ~400-600 input tokens per
      // call, uncached.
      systemBlocks.push({ type: "text", text: examplesBlockText });
    }
    body.system = systemBlocks;
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

    // Server-side validation of the AI's classification output.
    // The browser also runs normalizeTriageOutput, but the proxy is
    // the only chokepoint a client can't bypass. Pattern matches the
    // client exactly (coerce-with-safe-defaults via the shared
    // helper) and records what drifted in _relai.validation for AI-
    // drift telemetry. See PLAN.md "S3. AI output semantic trust."
    //
    // On hard parse failure (Anthropic 200 + valid envelope, but
    // content text not parseable as JSON), the original content is
    // passed through verbatim. The client's parseTriageJSON has a
    // brace-fallback for prose-wrapped JSON, and runTriage's catch
    // in app.js renders an actionable error notice when both layers
    // fail. When auto-send arrives (PLAN.md S3 trigger), the policy
    // here changes from coerce to reject.
    let validation = null;
    let normalized = null; // hoisted so downstream #1 checks can use it
    try {
      const blocks = Array.isArray(parsed.content) ? parsed.content : [];
      const rawText = blocks.map(function (b) { return (b && b.text) || ""; }).join("");
      if (!rawText) {
        validation = { parse_failed: true, reason: "empty_content" };
      } else {
        const aiParsed = parseTriageJSON(rawText);
        // Snapshot BEFORE normalize — normalizeTriageOutput is
        // shallow-copy and mutates review_request.confidence on the
        // input. Diffing against the post-normalize reference would
        // miss confidence-clamp drift.
        const aiParsedSnapshot = JSON.parse(JSON.stringify(aiParsed));
        normalized = normalizeTriageOutput(aiParsed);
        validation = diffNormalization(aiParsedSnapshot, normalized);
        if (blocks[0] && typeof blocks[0] === "object") {
          parsed.content = [
            Object.assign({}, blocks[0], { type: "text", text: JSON.stringify(normalized) }),
          ];
        }
      }
    } catch (e) {
      console.error("triage.validate:", e.message);
      validation = { parse_failed: true, reason: "unparseable_text" };
    }
    if (validation) {
      // Surface drift / parse failures in Netlify function logs.
      console.warn("triage.validation:", JSON.stringify(validation));
    }

    parsed._relai = {
      model: body.model,
      latency_ms: latencyMs,
      cost_usd: computeTriageCost(body.model, parsed.usage),
      // Echo the usage block at top level for convenience — clients
      // shouldn't have to know that Anthropic nests it.
      usage: parsed.usage || null,
      validation: validation,
    };

    // ─────────────────────────────────────────────────────────────
    // #1 patient-safety defenses (in order: parse → strict validate
    // → tripwire → Haiku second-pass). Each gate can independently
    // set route_to_human_review with a distinct route_reason; first
    // gate to fail "wins" and short-circuits the remaining gates
    // (we already know the message needs review).
    //
    // CLAUDE.md non-negotiable: malformed/missing/invalid → human
    // review, never automated routing.
    // ─────────────────────────────────────────────────────────────
    if (!normalized) {
      // Parse failure already covered above; mark for review.
      parsed._relai.route_to_human_review = true;
      parsed._relai.route_reason = "parse_failed";
    } else {
      // Strict enum/range validation. Distinct from S3a normalization:
      // S3a coerces "URGENT" → "urgent" silently; the strict pass
      // catches the residue (out-of-enum values that normalization
      // left as the default fallback, range violations, missing
      // required fields).
      const strict = validateTriageOutput(normalized);
      if (!strict.valid) {
        parsed._relai.route_to_human_review = true;
        parsed._relai.route_reason = "validation_failed";
        parsed._relai.validation_failure = strict;
        console.warn("triage.strict_validation:", JSON.stringify(strict));
      } else {
        // Tripwire scan. Substring match against the entire request
        // payload (patient message + any wrapper context). A
        // tripwire match OVERRIDES the AI's classification:
        // urgency→urgent, routing→severe, draft_response→warning
        // marker. Original AI output is snapshotted into
        // ai_original_output for staff visibility.
        const userText = (body.messages[0] && typeof body.messages[0].content === "string")
          ? body.messages[0].content : "";
        const tripwire = scanTripwires(userText);
        if (tripwire) {
          applyTripwireOverride(normalized, tripwire);
          parsed.content = [{ type: "text", text: JSON.stringify(normalized) }];
          parsed._relai.route_to_human_review = true;
          parsed._relai.route_reason = "tripwire";
          parsed._relai.tripwire = { category: tripwire.category, keyword: tripwire.keyword };
          console.warn("triage.tripwire:", JSON.stringify({ category: tripwire.category, keyword: tripwire.keyword }));
        } else if (process.env.RELAI_SECOND_PASS_HAIKU === "true") {
          // Haiku second-pass — only when validation passed AND no
          // tripwire (otherwise we'd be paying for a check whose
          // outcome can't change the existing escalation).
          const haiku = await haikuSecondPass(userText, normalized, apiKey);
          parsed._relai.haiku_second_pass = {
            verdict: haiku.verdict,
            raw: haiku.raw || null,
            cost_usd: haiku.cost_usd,
          };
          if (haiku.cost_usd != null) {
            parsed._relai.cost_usd = (parsed._relai.cost_usd || 0) + haiku.cost_usd;
          }
          if (haiku.verdict !== "agree") {
            parsed._relai.route_to_human_review = true;
            parsed._relai.route_reason = "haiku_" + haiku.verdict;
            console.warn("triage.haiku_second_pass:", JSON.stringify({ verdict: haiku.verdict, raw: haiku.raw }));
          }
        }
      }
    }

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
