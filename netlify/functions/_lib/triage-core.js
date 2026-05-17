// netlify/functions/_lib/triage-core.js
//
// Core triage orchestration extracted from netlify/functions/triage.js
// so the worker (netlify/functions/worker.js) can invoke the same
// code path without an HTTP round-trip + JWT dance. The HTTP endpoint
// (triage.js) becomes a thin wrapper that does auth + request-shape
// validation and then calls runTriage() here.
//
// Behavior must remain identical to pre-refactor triage.js for all
// existing /triage callers. All safety logic — multi-layer parse →
// strict validation → tripwire → optional Haiku second-pass — is
// preserved verbatim, only relocated.
//
// What this module does:
//   1. Load tenant KB
//   2. Load recent staff history for few-shot examples
//   3. Assemble system blocks with prompt-cache control
//   4. Call Anthropic /v1/messages
//   5. Parse + normalize the AI's JSON output
//   6. Run the full safety pipeline:
//        parse failure → strict validation → tripwire → Haiku
//   7. Return the parsed response with _relai telemetry
//
// What it does NOT do:
//   - JWT auth (caller's concern)
//   - HTTP body shape validation (caller's concern)
//   - Persistence — caller decides what to do with the result
//
// The helper is invocation-source agnostic. /triage passes in the
// user's resolved company_id and the patient_message from the
// request body; the worker passes in the row's company_id and
// patient_message from query_history.

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
} = require("../../../data/triage-lib");

const { BASE_PROMPT } = require("../../../data/base-prompt");
const { RELAI_DEFAULTS } = require("../../../data/defaults");
const { SUPABASE_URL, writeHeaders } = require("./supabase");

const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
]);
const MAX_TOKENS_CAP = 4096;

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

// Main orchestration. Both /triage (HTTP endpoint) and worker.js
// (background processor) call this. Returns either:
//   { ok: true, parsed, normalized } — full Anthropic-shape response
//     with _relai telemetry attached; normalized is the extracted
//     classification object (urgency, clinical_routing_level, etc.).
//   { ok: false, statusCode, error, raw? } — failure; statusCode is
//     the HTTP code the /triage endpoint should pass through; raw is
//     the upstream body when relevant (so the HTTP layer can forward
//     it verbatim for client-visible upstream errors).
async function runTriage({ companyId, patientMessage, model, maxTokens, apiKey }) {
  if (!ALLOWED_MODELS.has(model)) {
    return { ok: false, statusCode: 400, error: "Unsupported model." };
  }
  if (typeof maxTokens !== "number" || maxTokens <= 0) maxTokens = 1024;
  if (maxTokens > MAX_TOKENS_CAP) maxTokens = MAX_TOKENS_CAP;

  if (!companyId) {
    return { ok: false, statusCode: 500, error: "Caller has no resolved company_id; cannot assemble triage prompt." };
  }

  // KB load. Safety-critical: empty/failed KB load → fail-fast, not
  // "trust the AI to triage without rules."
  const kbRows = await loadKBForTenant(companyId);
  if (!kbRows || !kbRows.length) {
    return { ok: false, statusCode: 500, error: "KB unavailable for this tenant." };
  }

  // History load. Quality-critical only: failed load → empty
  // examples block, not a hard failure.
  const historyRows = await loadHistoryForExamples(companyId);

  // Assemble system blocks. BASE_PROMPT + KB are cached (cache_control
  // ephemeral); examples are intentionally uncached because they
  // shift as corrections accumulate and caching would poison the
  // cache prefix for every subsequent triage.
  const kbBlockText = buildFullKB(kbRows, RELAI_DEFAULTS.kb_sections);
  const examplesBlockText = buildStaffExamplesBlock(historyRows);
  const systemBlocks = [
    { type: "text", text: BASE_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: kbBlockText, cache_control: { type: "ephemeral" } },
  ];
  if (examplesBlockText) {
    systemBlocks.push({ type: "text", text: examplesBlockText });
  }

  const requestBody = {
    model: model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: [{ role: "user", content: patientMessage }],
  };

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error("triage.proxy:", err.message);
    return { ok: false, statusCode: 500, error: err.message };
  }

  const latencyMs = Date.now() - startedAt;
  const text = await response.text();

  // On non-2xx we still want the client to see the upstream error, but
  // we shouldn't try to enrich a response shape we don't trust. Pass
  // it through verbatim via `raw`.
  if (!response.ok) {
    return { ok: false, statusCode: response.status, error: "Upstream error", raw: text };
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    // Anthropic returned 200 but unparseable body — surface as 502.
    console.error("triage.parse:", e.message);
    return { ok: false, statusCode: 502, error: "Upstream returned malformed JSON." };
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
    model: model,
    latency_ms: latencyMs,
    cost_usd: computeTriageCost(model, parsed.usage),
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
      // Tripwire scan. Substring match against the patient message.
      // A tripwire match OVERRIDES the AI's classification:
      // urgency→urgent, routing→severe, draft_response→warning
      // marker. Original AI output is snapshotted into
      // ai_original_output for staff visibility.
      const tripwire = scanTripwires(patientMessage);
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
        const haiku = await haikuSecondPass(patientMessage, normalized, apiKey);
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

  return { ok: true, parsed, normalized };
}

module.exports = {
  runTriage,
  // Constants exposed so triage.js can reuse the same allowlists
  // without duplicating them — keeps the HTTP layer's validation
  // in sync with the helper's.
  ALLOWED_MODELS,
  MAX_TOKENS_CAP,
  // Internal helpers exposed for tests if needed later.
  loadKBForTenant,
  loadHistoryForExamples,
};
