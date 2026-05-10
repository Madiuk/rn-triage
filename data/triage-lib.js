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
  var hasSE = !!(parsed && parsed.clinical_routing_flag) && lvl !== 'none';
  var cat = (parsed && parsed.clinical_category || '').trim();
  var hasClinicalContent = cat && cat !== 'General Inquiry' && cat !== 'General/multiple';
  if (hasSE && lvl === 'severe')   return 'severe-se';
  if (hasSE && lvl === 'moderate') return 'moderate-se';
  if (hasSE && lvl === 'mild')     return 'mild-se';
  if (hasClinicalContent)          return 'clinical';
  if (parsed && parsed.non_clinical_flag) return 'non-clinical';
  return 'clinical';
}

// Task shape — orthogonal to priority. A 'dual' task has BOTH clinical
// and non-clinical components and requires extra routing work (paste an
// internal note into the EHR for the support team) on top of the
// clinical reply. 'single' covers everything else. Lets the queue UI
// flag dual tasks visually so staff know there's a routing step beyond
// the clinical response.
function taskShape(parsed) {
  if (!parsed) return 'single';
  var lvl = (parsed.clinical_routing_level || 'none').toLowerCase();
  var hasSE = !!parsed.clinical_routing_flag && lvl !== 'none';
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

// Node export hook — no-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTriageJSON,
    classifyMessage,
    computeUrgencyScore,
    priorityTier,
    taskShape,
    formatDuration,
    levenshteinDistance,
    computeTriageCost,
    simpleHash,
    TRIAGE_PRICING,
  };
}
