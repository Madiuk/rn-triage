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

// Node export hook — no-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTriageJSON,
    classifyMessage,
    computeUrgencyScore,
    priorityTier,
    formatDuration,
    levenshteinDistance,
  };
}
