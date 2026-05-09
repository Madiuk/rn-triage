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

// Compute a 0–10 priority score from the AI's classification. Pure.
function computeUrgencyScore(urgency, routingLevel, hasSideEffect) {
  var base = urgency === 'urgent' ? 9 : urgency === 'same-day' ? 6 : 3;
  var sev = routingLevel === 'severe' ? 2 : routingLevel === 'moderate' ? 1 : 0;
  return Math.min(10, base + (hasSideEffect ? sev : 0));
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
    formatDuration,
    levenshteinDistance,
  };
}
