// data/triage-lib.js
// Pure helper functions used during triage. Loaded as a global before
// app.js (browser) and required by tests (Node). No DOM or fetch
// dependencies allowed in this file.

// Parse the AI's JSON output. The model occasionally wraps it in code
// fences or adds stray prose; this is forgiving but throws if it can't
// find a parsable object.
function parseTriageJSON(raw) {
  var cleaned = (raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  var s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s !== -1 && e > s) return JSON.parse(cleaned.substring(s, e + 1));
  throw new Error('Could not parse triage JSON.');
}

// Normalize the AI's parsed triage output to canonical enum values
// before persistence and rendering. The AI is instructed to use
// specific casing/spelling for urgency, clinical_routing_level, and
// clinical_category, but occasionally drifts:
//   * Returns 'URGENT' / 'Urgent' / 'urgent ' instead of 'urgent'.
//   * Returns "Side Effect" or "side effects" instead of "Side Effects".
//   * Returns confidence > 1.0 (rare but possible).
//   * Returns scalar where an array is expected (or vice versa).
//
// Any of those silently corrupt aggregations (Top Category counts
// "Side Effect" and "Side Effects" as different buckets), break the
// pill-selection UI (strict equality miss), or skew confidence-rate
// metrics. Normalize once, at parse time, and everything downstream
// gets clean data.
//
// Unknown values are kept (trimmed) rather than silently coerced, so
// staff can see what the AI actually returned and correct it. The
// helper is pure — given the same input, returns the same output —
// and operates on a shallow copy.
function normalizeTriageOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  var out = {};
  for (var k in parsed) out[k] = parsed[k];

  // urgency: routine | same-day | urgent
  out.urgency = normalizeEnum(out.urgency, [
    'routine', 'same-day', 'urgent',
  ]) || 'routine';

  // clinical_routing_level: severe | moderate | mild | none
  out.clinical_routing_level = normalizeEnum(out.clinical_routing_level, [
    'severe', 'moderate', 'mild', 'none',
  ]) || 'none';

  // clinical_category: 6-value enum (case-sensitive). Match
  // case-insensitively, return the canonical form. Unknown values
  // pass through trimmed so we don't mask AI mistakes.
  var canonicalCategories = [
    'Injection/Dosing',
    'Side Effects',
    'Severe Side Effects',
    'Medication Management',
    'Stall/Lack of Results',
    'General Inquiry',
  ];
  out.clinical_category = normalizeEnum(out.clinical_category, canonicalCategories);
  if (out.clinical_category == null && parsed.clinical_category != null) {
    // Unknown — preserve trimmed raw value so staff can see + correct.
    out.clinical_category = String(parsed.clinical_category).trim();
  }

  // routed_to: 5-value enum from BASE_PROMPT. AI drift here means
  // routing aggregations split (e.g., "Shipping" and "Shipping &
  // Fulfillment" become separate buckets). Same canonicalize-or-
  // preserve pattern as clinical_category.
  var canonicalRoutedTo = [
    'Shipping & Fulfillment',
    'Billing Team',
    'Account Support',
    'Pharmacy Team',
    'General Support',
  ];
  if (typeof out.routed_to === 'string' && out.routed_to.trim()) {
    var rt = normalizeEnum(out.routed_to, canonicalRoutedTo);
    out.routed_to = rt != null ? rt : String(out.routed_to).trim();
  }

  // review_request.context: 5-value enum (routing | severity |
  // category | kb_gap | protocol). The resolve handler in kb.js
  // does strict equality on this value to decide whether to
  // promote the answer to KB (ctx === 'kb_gap' || ctx === 'protocol').
  // If the AI returns 'KB_gap' (uppercase) or 'kbgap' (no underscore),
  // strict equality misses, promotion doesn't run, the answer
  // never reaches the KB. The active learning loop fails silently
  // for that case. Normalize before save so the resolve handler's
  // strict check works on canonical values.
  var canonicalContexts = ['routing', 'severity', 'category', 'kb_gap', 'protocol'];
  if (out.review_request && typeof out.review_request.context === 'string') {
    var rc = normalizeEnum(out.review_request.context, canonicalContexts);
    if (rc != null) out.review_request.context = rc;
    // If unknown, leave as-is — the resolve handler treats unknown
    // contexts as 'general' (no promotion), which is the safest
    // fallback.
  }

  // Booleans coerced.
  out.non_clinical_flag = !!out.non_clinical_flag;
  out.clinical_routing_flag = !!out.clinical_routing_flag;

  // Arrays coerced.
  if (!Array.isArray(out.non_clinical_items))     out.non_clinical_items = [];
  if (!Array.isArray(out.follow_up_questions))    out.follow_up_questions = [];

  // ai_confidence clamped to [0, 1] if present.
  if (out.review_request && typeof out.review_request.confidence === 'number') {
    var c = out.review_request.confidence;
    if (c < 0) c = 0;
    if (c > 1) c = 1;
    out.review_request.confidence = c;
  }

  return out;
}

// Compare an AI-emitted parsed-triage object to its normalized form
// and return a structured record of which clinically-meaningful
// fields drifted. Used by the /triage proxy to populate the
// `_relai.validation` envelope for AI-drift telemetry. Returns null
// when nothing tracked drifted (suppresses noise on clean responses).
//
// NOTE on the snapshot requirement: normalizeTriageOutput is shallow-
// copy and mutates nested objects (notably review_request.confidence).
// Callers that want to diff against the AI's raw output must snapshot
// the parsed object BEFORE normalize, e.g. via
// `JSON.parse(JSON.stringify(parsed))`. Passing the post-normalize
// reference would miss confidence-clamp drift.
//
// Boolean and array coercions are shape fixes, not value drifts —
// intentionally not tracked here.
function diffNormalization(rawParsed, normalized) {
  if (!rawParsed || !normalized || typeof rawParsed !== 'object' || typeof normalized !== 'object') {
    return null;
  }
  var drifts = [];
  var scalarFields = ['urgency', 'clinical_routing_level', 'clinical_category', 'routed_to'];
  for (var i = 0; i < scalarFields.length; i++) {
    var f = scalarFields[i];
    var before = rawParsed[f];
    var after = normalized[f];
    if (before !== after && (before != null || after != null)) {
      drifts.push({ field: f, received: before, coerced_to: after });
    }
  }
  var rrBefore = rawParsed.review_request;
  var rrAfter = normalized.review_request;
  if (rrBefore && rrAfter && typeof rrBefore === 'object' && typeof rrAfter === 'object') {
    if (rrBefore.context !== rrAfter.context && (rrBefore.context != null || rrAfter.context != null)) {
      drifts.push({ field: 'review_request.context', received: rrBefore.context, coerced_to: rrAfter.context });
    }
    if (typeof rrBefore.confidence === 'number' && rrBefore.confidence !== rrAfter.confidence) {
      drifts.push({ field: 'review_request.confidence', received: rrBefore.confidence, coerced_to: rrAfter.confidence });
    }
  }
  return drifts.length > 0 ? { drifts: drifts } : null;
}

// Helper: case-insensitive trim match against a list of canonical
// values. Returns the canonical value or null if no match. Used by
// normalizeTriageOutput.
function normalizeEnum(value, canonicalList) {
  if (typeof value !== 'string') return null;
  var trimmed = value.trim();
  var lower = trimmed.toLowerCase();
  for (var i = 0; i < canonicalList.length; i++) {
    if (canonicalList[i].toLowerCase() === lower) return canonicalList[i];
  }
  return null;
}

// Decide which KB sections to include in the system prompt for a given
// patient message. Runs client-side, zero cost, zero latency.
function classifyMessage(msg) {
  var m = (msg || '').toLowerCase();
  var types = ['rules', 'routing'];

  if (/bill|pay|charg|invoice|refund|ship|track|deliver|package|order|account|subscri|cancel|prescription transfer|pharmacy|credit card|receipt/.test(m)) {
    types.push('routing_detail');
  }

  var sideEffect = /nausea|vomit|sick|diarrhea|constip|heartburn|reflux|hair|fatigue|tired|inject|site|react|itch|swell|rash|pain|hurt|ache|hypoglyc|shak|sweat|dizz|weak|fever|bleed/.test(m);
  if (sideEffect) { types.push('sideeffects'); types.push('protocols'); }

  var weightFocus = /weight|plateau|stall|loss|gain|scale|food noise|crav|hungry|hunger|calorie|eat|diet|appetite/.test(m);
  if (weightFocus) types.push('templates');

  var dosing = /dose|dosing|inject|units|mg|ml|syringe|vial|concentrat|titrat|missed|skip|forgot|storage|refriger|freez/.test(m);
  if (dosing) types.push('protocols');

  if (weightFocus) types.push('urls');

  // If nothing matched, still include sideeffects rules so the AI has
  // classification material.
  if (!sideEffect && !weightFocus && !dosing) types.push('sideeffects');

  return Array.from(new Set(types));
}

// Compute a 1–10 priority score from the AI's classification. Pure.
//
// Tiered so that side effects always rank above non-side-effect clinical
// questions, and clinical content always ranks above non-clinical only.
// Within each tier the AI's `urgency` ('urgent' / 'same-day' / 'routine')
// shifts the score by 1 so the queue surfaces the most pressing item
// first when integrations push tasks in automatically.
//
// Score map:
//   10  Severe side effect, urgent
//    9  Severe side effect, non-urgent
//    8  Moderate side effect, urgent
//    7  Moderate side effect, non-urgent
//    6  Mild side effect, urgent
//    5  Mild side effect, non-urgent
//    4  Clinical question (no side effect), urgent
//    3  Clinical question (no side effect), non-urgent
//    2  Non-clinical only, urgent
//    1  Non-clinical only, non-urgent
//
// Accepts either a parsed triage object or three positional args
// (back-compat with older callers that pass urgency, routingLevel, hasSideEffect).
function computeUrgencyScore(parsedOrUrgency, routingLevel, hasSideEffect) {
  var parsed;
  if (parsedOrUrgency && typeof parsedOrUrgency === 'object') {
    parsed = parsedOrUrgency;
  } else {
    parsed = {
      urgency: parsedOrUrgency,
      clinical_routing_level: routingLevel,
      clinical_routing_flag: !!hasSideEffect,
    };
  }
  var urgency = (parsed.urgency || 'routine').toLowerCase();
  var lvl = (parsed.clinical_routing_level || 'none').toLowerCase();
  var hasSE = !!(parsed.clinical_routing_flag) && lvl !== 'none';
  var cat = (parsed.clinical_category || '').trim();
  var hasClinicalContent = cat && cat !== 'General Inquiry' && cat !== 'General/multiple';
  var nonClinicalOnly = !!parsed.non_clinical_flag && !hasSE && !hasClinicalContent;

  var tier;
  if (hasSE && lvl === 'severe')        tier = 9;   // 9–10
  else if (hasSE && lvl === 'moderate') tier = 7;   // 7–8
  else if (hasSE && lvl === 'mild')     tier = 5;   // 5–6
  else if (hasClinicalContent)          tier = 3;   // 3–4
  else if (nonClinicalOnly)             tier = 1;   // 1–2
  else                                  tier = 3;   // unclassified → treat as clinical question

  var bump = urgency === 'urgent' ? 1 : 0;
  return Math.min(10, tier + bump);
}

// High-level priority tier — useful for filter dropdowns, color-coding,
// and stack-ranking. Returns one of:
//   'severe-se' | 'moderate-se' | 'mild-se' | 'clinical' | 'non-clinical'
function priorityTier(parsed) {
  var lvl = (parsed && parsed.clinical_routing_level || 'none').toLowerCase();
  // hasSE is derived from clinical_routing_level alone — earlier
  // versions also required parsed.clinical_routing_flag, but that
  // flag is NOT a column on query_history (we never persist it).
  // So when this function ran on a row loaded from the DB,
  // clinical_routing_flag was always undefined → hasSE was always
  // false → severe/moderate/mild SE rows were silently classified
  // as plain "clinical" tier in the queue, breaking the queue
  // filter for "Severe Side Effects" (it never matched anything).
  // For triage-time parsed AI output the flag and level are
  // coherent anyway (the AI's prompt requires it), so dropping
  // the flag check changes nothing for that path.
  var hasSE = lvl !== 'none';
  var cat = (parsed && parsed.clinical_category || '').trim();
  var hasClinicalContent = cat && cat !== 'General Inquiry' && cat !== 'General/multiple';
  if (hasSE && lvl === 'severe')   return 'severe-se';
  if (hasSE && lvl === 'moderate') return 'moderate-se';
  if (hasSE && lvl === 'mild')     return 'mild-se';
  if (hasClinicalContent)          return 'clinical';
  if (parsed && parsed.non_clinical_flag) return 'non-clinical';
  return 'clinical';
}

// Build a human-readable category string for table/list display.
// Combines clinical_category (text) and non_clinical_items (jsonb
// array) into one line. Earlier the queue's Category column showed
// only clinical_category — non-clinical-only triages appeared with
// an empty Category cell even though the staff had selected
// non-clinical pills and saved them. The data was correct in the
// DB (non_clinical_items array); the display just didn't read it.
//
// Output shape:
//   clinical only: "Side Effects"
//   non-clinical only: "Billing/Payment, Shipment/Tracking"
//   dual: "Side Effects · Billing/Payment"
//   empty: ""
function formatCategoryDisplay(row) {
  if (!row) return '';
  var parts = [];
  if (row.clinical_category) parts.push(row.clinical_category);
  if (Array.isArray(row.non_clinical_items) && row.non_clinical_items.length) {
    parts.push(row.non_clinical_items.join(', '));
  }
  return parts.join(' · ');
}

// Task shape — orthogonal to priority. A 'dual' task has BOTH clinical
// and non-clinical components and requires extra routing work (an
// internal handoff to the support team — Bask thread comment, internal
// email, ticket, whatever the channel uses) on top of the clinical
// reply. 'single' covers everything else. Lets the queue UI flag dual
// tasks visually so staff know there's a routing step beyond the
// clinical response.
function taskShape(parsed) {
  if (!parsed) return 'single';
  var lvl = (parsed.clinical_routing_level || 'none').toLowerCase();
  // Same fix as priorityTier — derive hasSE from level alone, not
  // from the unpersisted clinical_routing_flag. Saved rows never
  // had the flag, which made every SE row in the queue silently
  // classify as 'single' instead of 'dual' if it also had non-
  // clinical items.
  var hasSE = lvl !== 'none';
  var cat = (parsed.clinical_category || '').trim();
  var hasClinicalContent = hasSE || (cat && cat !== 'General Inquiry' && cat !== 'General/multiple');
  var items = parsed.non_clinical_items;
  var hasNonClin = !!parsed.non_clinical_flag || (Array.isArray(items) && items.length > 0);
  return (hasClinicalContent && hasNonClin) ? 'dual' : 'single';
}

// Format a duration in seconds for display ("12s", "2m 30s").
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  if (seconds < 60) return Math.round(seconds) + 's';
  var m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return s ? (m + 'm ' + s + 's') : (m + 'm');
}

// Levenshtein edit distance between two strings. Used as a reward
// signal — small distance = AI draft was nearly perfect, large distance
// = staff rewrote the response. Iterative DP, O(n*m) time, O(min) space.
function levenshteinDistance(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Ensure b is the shorter one for memory.
  if (a.length < b.length) { var t = a; a = b; b = t; }
  var prev = new Array(b.length + 1);
  var curr = new Array(b.length + 1);
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (var k = 1; k <= b.length; k++) {
      var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
      curr[k] = Math.min(
        prev[k] + 1,        // deletion
        curr[k - 1] + 1,    // insertion
        prev[k - 1] + cost  // substitution
      );
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

// Anthropic list pricing in USD per 1M tokens. Source of truth at
// https://www.anthropic.com/pricing — keep this table in sync when
// pricing changes. Used both server-side (triage.js) for per-request
// cost stamping and client-side for any cost displays.
//
// `cache_write_5m` is what Anthropic calls "cache creation" (5-minute
// TTL, the default we use). `cache_read` is the per-token rate when a
// request hits a warm cache.
var TRIAGE_PRICING = {
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cache_write_5m: 3.75,  cache_read: 0.30 },
  'claude-haiku-4-5':  { input: 1.00,  output:  5.00, cache_write_5m: 1.25,  cache_read: 0.10 },
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cache_write_5m: 18.75, cache_read: 1.50 },
};

// Compute USD cost of a single Anthropic /v1/messages response from
// the model id and the `usage` block Anthropic returns. Returns null
// when the model is unpriced (so callers can store NULL rather than a
// wrong number). Rounded to 6 decimals to match the
// query_history.cost_usd column's numeric(10,6).
function computeTriageCost(model, usage) {
  var p = TRIAGE_PRICING[model];
  if (!p || !usage) return null;
  var fresh  = (usage.input_tokens                 || 0) * p.input          / 1e6;
  var out    = (usage.output_tokens                || 0) * p.output         / 1e6;
  var cWrite = (usage.cache_creation_input_tokens  || 0) * p.cache_write_5m / 1e6;
  var cRead  = (usage.cache_read_input_tokens      || 0) * p.cache_read     / 1e6;
  return Math.round((fresh + out + cWrite + cRead) * 1e6) / 1e6;
}

// Decide whether resolving a task in this category requires clinical
// authorization (i.e. only an RN/PA/MD on the staff can send the
// reply). The caller passes the per-category metadata object — in the
// browser, this is `RELAI_DEFAULTS.categories` from data/defaults.js
// (eventually overridden per tenant). Pure, parameterized, testable.
//
// Conservative defaults:
//   - empty / unknown / unmapped category → return true (require auth)
//   - explicit `requires_clinical_authorization: false` → return false
//   - anything else → return true
//
// Rationale: an under-gate (a non-clinical staffer accidentally
// resolves a clinical task) is a worse failure mode than an over-gate
// (a few extra reassignments by staff who can't take the task).
function requiresClinicalAuthorization(categoryName, categoryMetadata) {
  var cat = String(categoryName == null ? '' : categoryName).trim();
  if (!cat) return true;
  var meta = categoryMetadata && categoryMetadata[cat];
  if (meta && typeof meta.requires_clinical_authorization === 'boolean') {
    return meta.requires_clinical_authorization;
  }
  return true;
}

// Stable, fast 32-bit string hash (djb2 variant). Used to stamp every
// triage with the prompt_version and kb_version it ran against, so a
// regression can be attributed to a specific prompt or KB revision
// instead of guessed at. Not cryptographic — collisions are rare
// enough at our scale and we only need "did this change since last
// triage." Returns 8-char lowercase hex.
function simpleHash(str) {
  var s = String(str || '');
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0; // h*33 + c, kept 32-bit
  }
  // Convert to unsigned and pad to 8 hex chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Shared "is this a clinical result?" predicate. Used by:
//   - Browser: renderResults uses this to decide whether a
//     non-clinical user gets the simplified handoff view or the
//     standard render (app.js).
//   - Server: not directly — the server has its own
//     rowIsClinical in netlify/functions/_lib/permissions.js
//     because the server can't reliably require this file from
//     inside a Netlify Function bundle. The contract test in
//     tests/clinicalDetection.test.js enforces that the two
//     implementations agree on a battery of test inputs. If
//     either side changes the rule, the test fails and we know
//     to update the other.
//
// Rules (must stay aligned with permissions.rowIsClinical):
//   - Any side-effect detection (clinical_routing_level !== 'none')
//     → clinical, full stop.
//   - clinical_category set, EXCEPT 'General Inquiry' (which is
//     is_clinical=false per Big Easy's category_metadata seed)
//     and the legacy 'General/multiple' value → clinical.
//   - Otherwise → not clinical.
function resultIsClinical(d) {
  if (!d) return false;
  var lvl = String((d.clinical_routing_level || 'none')).toLowerCase();
  if (lvl !== 'none') return true;
  var cat = String(d.clinical_category || '').trim();
  if (cat && cat !== 'General Inquiry' && cat !== 'General/multiple') return true;
  return false;
}

// Node export hook — no-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTriageJSON,
    normalizeTriageOutput,
    diffNormalization,
    classifyMessage,
    computeUrgencyScore,
    priorityTier,
    taskShape,
    formatCategoryDisplay,
    formatDuration,
    levenshteinDistance,
    computeTriageCost,
    simpleHash,
    requiresClinicalAuthorization,
    resultIsClinical,
    TRIAGE_PRICING,
  };
}
