#!/usr/bin/env node
// eval/run.js
// Regression harness for triage outputs. Loads every case in eval/cases/,
// runs each against the current BASE_PROMPT + DEFAULT_KB, scores the
// model's output against the case's `expected` rules, writes a
// timestamped JSON to eval/results/, prints a summary, exits non-zero
// when any case fails.
//
// Two modes:
//   1. (default) Direct Anthropic call. Requires ANTHROPIC_API_KEY env.
//   2. --endpoint <url>: POST to a triage-proxy URL instead (e.g. a
//      running `netlify dev` instance). Useful for end-to-end tests.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node eval/run.js
//   node eval/run.js --case panc-001
//   node eval/run.js --endpoint http://localhost:8888/.netlify/functions/triage
//   node eval/run.js --model claude-haiku-4-5
//
// Why direct-call as the default: it lets you re-run the harness on a
// new prompt or KB version without standing up the function locally —
// the harness itself becomes the only thing that needs to know how the
// triage call is shaped, and it stays in lock-step with triage.js
// because both pull pricing from data/triage-lib.js.

const fs   = require('fs');
const path = require('path');

const { BASE_PROMPT, BASE_PROMPT_TEMPLATE } = require('../data/base-prompt.js');
const { DEFAULT_KB }  = require('../data/default-kb.js');
const { RELAI_DEFAULTS } = require('../data/defaults.js');
const {
  parseTriageJSON,
  normalizeTriageOutput,
  computeTriageCost,
  simpleHash,
} = require('../data/triage-lib.js');

// ── Args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const onlyCase = flag('case', null);
const endpoint = flag('endpoint', null);
const model    = flag('model', 'claude-sonnet-4-6');
// Optional Supabase JWT for hitting an auth-gated triage proxy via
// --endpoint. Grab one from your browser's localStorage (key
// `relai_session`, then `.access_token`) and pass --token <value>
// or set RELAI_EVAL_TOKEN. Direct-Anthropic mode (the default) does
// not need a token.
const token    = flag('token', process.env.RELAI_EVAL_TOKEN || null);

// ── Build the same KB string the browser sends ────────────────────────
// Section order + labels come from RELAI_DEFAULTS.kb_sections (single
// source of truth shared with app.js's getFullKB) so the eval renders
// the exact same KB layout production sends. The kb_version hash will
// match production's hash so long as the seed in default-kb.js matches
// the live tenant KB.
function buildKBString(kb) {
  return (RELAI_DEFAULTS.kb_sections || []).map(s => {
    const rows = kb[s.key] || [];
    if (!rows.length) return '';
    return '=== ' + s.label + ' ===\n' +
      rows.map(e => '[' + e.name + ']\n' + e.text).join('\n\n');
  }).filter(Boolean).join('\n\n');
}

const KB_STRING       = buildKBString(DEFAULT_KB);
// Hash the template (not the rendered prompt). The rendered prompt
// has today's date substituted in, so hashing it would change every
// day with no actual prompt change. See data/base-prompt.js comments.
const PROMPT_VERSION  = simpleHash(BASE_PROMPT_TEMPLATE);
const KB_VERSION      = simpleHash(KB_STRING);

// ── Load cases ────────────────────────────────────────────────────────
const casesDir = path.join(__dirname, 'cases');
let cases = fs.readdirSync(casesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')));

if (onlyCase) {
  cases = cases.filter(c => c.id === onlyCase);
  if (!cases.length) {
    console.error('No case with id "' + onlyCase + '" found.');
    process.exit(2);
  }
}

// ── Triage caller ─────────────────────────────────────────────────────
async function callTriage(message, priorContext) {
  // Mirror the prior-context wrapper wording used in app.js's
  // runTriage. The eval should test what production sends. If
  // the wrappers diverge, the eval's kb_version/prompt_version
  // numbers stay the same but the actual prompt the model sees
  // would differ from production — silent drift between eval and
  // reality. Updated 2026-05-11 alongside the v0.3.16 production
  // change to the wrapper.
  const userContent = priorContext
    ? 'PRIOR CONVERSATION (earlier messages in this thread — use as context. The patient already received any information stated here, so do not repeat education they already got. Reference specific facts they shared (dose, TDEE, weight goals, symptom timing, prior side effects) when relevant to your response):\n\n'
      + priorContext
      + '\n\n---\n\nLATEST PATIENT MESSAGE (this is the message you are triaging and drafting a response to now — tailor your reply to what they are asking right now, drawing on the prior conversation when relevant):\n\n'
      + message
    : message;

  const requestBody = {
    model,
    max_tokens: 600,
    system: [
      { type: 'text', text: BASE_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: KB_STRING,   cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userContent }],
  };

  let url, headers;
  if (endpoint) {
    url = endpoint;
    headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set, and no --endpoint given.');
    }
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
  }

  const startedAt = Date.now();
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });
  const text = await r.text();
  const latency = Date.now() - startedAt;

  if (!r.ok) {
    throw new Error('Triage call failed (' + r.status + '): ' + text.slice(0, 300));
  }

  let body;
  try { body = JSON.parse(text); }
  catch (e) { throw new Error('Non-JSON triage response: ' + text.slice(0, 300)); }

  const raw = (body.content || []).map(b => b.text || '').join('');
  const usage = body.usage || (body._relai && body._relai.usage) || null;
  const cost = computeTriageCost(model, usage);
  // Normalize before scoring — the eval should test what the
  // production system actually persists, not the raw AI output.
  // Without this, an AI returning 'URGENT' uppercase would pass
  // `urgency` matching by accident (both sides lowercased) but a
  // strict-equality check on the expected enum would fail.
  return {
    parsed: normalizeTriageOutput(parseTriageJSON(raw)),
    raw,
    usage,
    cost_usd: cost,
    latency_ms: latency,
  };
}

// ── Scoring ───────────────────────────────────────────────────────────
function lc(s) { return String(s == null ? '' : s).toLowerCase(); }

function scoreCase(testCase, parsed) {
  const failures = [];
  const ex = testCase.expected || {};

  if (ex.urgency != null && lc(parsed.urgency) !== lc(ex.urgency)) {
    failures.push('urgency: expected "' + ex.urgency + '", got "' + parsed.urgency + '"');
  }

  if (ex.clinical_routing_level != null
      && lc(parsed.clinical_routing_level || 'none') !== lc(ex.clinical_routing_level)) {
    failures.push('clinical_routing_level: expected "' + ex.clinical_routing_level
      + '", got "' + (parsed.clinical_routing_level || 'none') + '"');
  }

  if (Array.isArray(ex.clinical_category) && ex.clinical_category.length) {
    const got = lc(parsed.clinical_category);
    const ok = ex.clinical_category.some(c => got.includes(lc(c)));
    if (!ok) {
      failures.push('clinical_category: expected one of '
        + JSON.stringify(ex.clinical_category)
        + ', got "' + (parsed.clinical_category || '') + '"');
    }
  }

  if (typeof ex.non_clinical_flag === 'boolean'
      && Boolean(parsed.non_clinical_flag) !== ex.non_clinical_flag) {
    failures.push('non_clinical_flag: expected ' + ex.non_clinical_flag
      + ', got ' + Boolean(parsed.non_clinical_flag));
  }

  if (Array.isArray(ex.non_clinical_items_includes) && ex.non_clinical_items_includes.length) {
    const items = (parsed.non_clinical_items || []).map(lc);
    ex.non_clinical_items_includes.forEach(item => {
      if (!items.some(i => i.includes(lc(item)))) {
        failures.push('non_clinical_items missing "' + item + '" (got '
          + JSON.stringify(parsed.non_clinical_items || []) + ')');
      }
    });
  }

  if (Array.isArray(ex.draft_must_include_any) && ex.draft_must_include_any.length) {
    const draft = lc(parsed.draft_response);
    const ok = ex.draft_must_include_any.some(p => draft.includes(lc(p)));
    if (!ok) {
      failures.push('draft_must_include_any: none of '
        + JSON.stringify(ex.draft_must_include_any) + ' present');
    }
  }

  if (Array.isArray(ex.draft_must_not_include) && ex.draft_must_not_include.length) {
    // Word-boundary match (NOT substring). "ER" must not appear as a
    // standalone word, but words like "consider" / "after" / "delivery"
    // are fine — they just happen to contain the letters "er". Same
    // story for "wait" vs "waiting", "911" vs anything (digits also
    // get word boundaries). Case-insensitive via the /i flag.
    const draft = String(parsed.draft_response || '');
    ex.draft_must_not_include.forEach(p => {
      const escaped = String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'i');
      if (re.test(draft)) {
        failures.push('draft_must_not_include violated by "' + p + '"');
      }
    });
  }

  // routed_to: case-insensitive exact match against the canonical
  // enum from BASE_PROMPT. Distinct from clinical_category — drift
  // here means routing aggregations split (e.g. "Shipping" vs
  // "Shipping & Fulfillment" become separate buckets in dashboards).
  // Optional — most cases don't assert routed_to.
  if (ex.routed_to != null && lc(parsed.routed_to || '') !== lc(ex.routed_to)) {
    failures.push('routed_to: expected "' + ex.routed_to
      + '", got "' + (parsed.routed_to || '') + '"');
  }

  // review_request scoring — additive in v0.4.0 to enable cases like
  // low-confidence-001 that exercise the AI's self-rated confidence
  // and the active-learning-loop entrypoint. Ignored when the
  // expected.review_request key is absent (so existing cases are
  // unchanged).
  if (ex.review_request && typeof ex.review_request === 'object') {
    const rr = parsed.review_request || null;
    const hasRR = rr && typeof rr === 'object';

    if (ex.review_request.required === true && !hasRR) {
      failures.push('review_request: expected to be present, got null/undefined');
    }

    if (typeof ex.review_request.max_confidence === 'number') {
      if (!hasRR || typeof rr.confidence !== 'number') {
        failures.push('review_request.confidence: expected <= '
          + ex.review_request.max_confidence + ', got ' + (hasRR ? rr.confidence : 'no review_request'));
      } else if (rr.confidence > ex.review_request.max_confidence) {
        failures.push('review_request.confidence: expected <= '
          + ex.review_request.max_confidence + ', got ' + rr.confidence);
      }
    }

    if (typeof ex.review_request.min_confidence === 'number') {
      if (!hasRR || typeof rr.confidence !== 'number') {
        failures.push('review_request.confidence: expected >= '
          + ex.review_request.min_confidence + ', got ' + (hasRR ? rr.confidence : 'no review_request'));
      } else if (rr.confidence < ex.review_request.min_confidence) {
        failures.push('review_request.confidence: expected >= '
          + ex.review_request.min_confidence + ', got ' + rr.confidence);
      }
    }

    if (Array.isArray(ex.review_request.context_in) && ex.review_request.context_in.length) {
      const allowed = ex.review_request.context_in.map(lc);
      if (!hasRR || !allowed.includes(lc(rr.context))) {
        failures.push('review_request.context: expected one of '
          + JSON.stringify(ex.review_request.context_in)
          + ', got "' + (hasRR ? rr.context : 'no review_request') + '"');
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Run ───────────────────────────────────────────────────────────────
async function main() {
  console.log('Care Station eval — ' + cases.length + ' case(s)');
  console.log('  model:           ' + model);
  console.log('  endpoint:        ' + (endpoint || 'direct Anthropic'));
  console.log('  prompt_version:  ' + PROMPT_VERSION);
  console.log('  kb_version:      ' + KB_VERSION);
  console.log('');

  const startedAt = new Date();
  const results = [];
  let totalCost = 0;
  let totalLatency = 0;
  let cacheReadTokens = 0, cacheWriteTokens = 0, freshInputTokens = 0;

  for (const c of cases) {
    process.stdout.write('  [' + c.id + '] ' + (c.description || '').slice(0, 70));
    let outcome;
    try {
      const out = await callTriage(c.input.message, c.input.prior_context || '');
      const score = scoreCase(c, out.parsed);
      outcome = {
        id: c.id,
        description: c.description,
        passed: score.passed,
        failures: score.failures,
        latency_ms: out.latency_ms,
        cost_usd: out.cost_usd,
        usage: out.usage,
        actual: {
          urgency: out.parsed.urgency,
          clinical_routing_level: out.parsed.clinical_routing_level,
          clinical_category: out.parsed.clinical_category,
          non_clinical_flag: out.parsed.non_clinical_flag,
          non_clinical_items: out.parsed.non_clinical_items,
          ai_confidence: out.parsed.review_request && out.parsed.review_request.confidence,
        },
      };
      if (out.cost_usd) totalCost += out.cost_usd;
      totalLatency += out.latency_ms;
      if (out.usage) {
        cacheReadTokens  += out.usage.cache_read_input_tokens     || 0;
        cacheWriteTokens += out.usage.cache_creation_input_tokens || 0;
        freshInputTokens += out.usage.input_tokens                || 0;
      }
    } catch (err) {
      outcome = {
        id: c.id,
        description: c.description,
        passed: false,
        failures: ['call_error: ' + err.message],
        error: err.message,
      };
    }
    results.push(outcome);
    process.stdout.write('  ' + (outcome.passed ? 'PASS' : 'FAIL') + '\n');
    if (!outcome.passed) {
      outcome.failures.forEach(f => console.log('      - ' + f));
    }
    // Bail out on auth errors. The same key/token won't magically become
    // valid on the next case, and grinding through 7 failures wastes the
    // user's time + log noise. Other failures (a single bad triage
    // classification) shouldn't abort — that's the regression we want
    // to see fully.
    if (outcome.error && /\(401\)|\(403\)|invalid x-api-key|ANTHROPIC_API_KEY|Authentication required/i.test(outcome.error)) {
      console.log('');
      if (endpoint) {
        console.log('  Aborting: authentication failed against the triage proxy.');
        console.log('  /triage and /analyze now require a Supabase session token.');
        console.log('  Grab one from your browser at the live app:');
        console.log('    localStorage.relai_session  →  parse JSON  →  .access_token');
        console.log('  Then re-run with --token <jwt> (or set RELAI_EVAL_TOKEN).');
      } else {
        console.log('  Aborting: authentication with Anthropic failed.');
        console.log('  Check that ANTHROPIC_API_KEY is a valid key from');
        console.log('  https://console.anthropic.com/settings/keys');
      }
      break;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const cacheTotal = cacheReadTokens + cacheWriteTokens + freshInputTokens;
  const cacheHitRate = cacheTotal > 0 ? cacheReadTokens / cacheTotal : 0;

  console.log('');
  console.log('Summary');
  console.log('  passed:           ' + passed + ' / ' + results.length);
  console.log('  failed:           ' + failed);
  console.log('  total cost:       $' + totalCost.toFixed(4));
  console.log('  mean latency:     ' + Math.round(totalLatency / Math.max(results.length, 1)) + ' ms');
  console.log('  cache hit rate:   ' + (cacheHitRate * 100).toFixed(1) + '% of input tokens');

  // ── Persist results ─────────────────────────────────────────────────
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(resultsDir, stamp + '.json');
  const summary = {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    model,
    endpoint: endpoint || null,
    prompt_version: PROMPT_VERSION,
    kb_version: KB_VERSION,
    total_cases: results.length,
    passed,
    failed,
    total_cost_usd: Number(totalCost.toFixed(6)),
    mean_latency_ms: Math.round(totalLatency / Math.max(results.length, 1)),
    cache_hit_rate: Number(cacheHitRate.toFixed(4)),
    cases: results,
  };
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log('  results written:  ' + path.relative(process.cwd(), outFile));

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('eval.fatal:', err.message);
  process.exit(2);
});
