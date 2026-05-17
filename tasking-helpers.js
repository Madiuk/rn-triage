// tasking-helpers.js
//
// Pure helpers used by tasking.js. Lives in its own file so:
//   1. It can be unit-tested in Node without dragging in the
//      browser-only IIFE in tasking.js (which calls document.*,
//      window.*, fetch, localStorage at runtime).
//   2. Other future SPA pages can reuse the same helpers via the
//      same <script> tag.
//
// NO browser APIs allowed here. Plain data in, plain data out.

// Build the toast text for a /worker invocation response.
// Worker shape variants from netlify/functions/worker.js:
//   - { processed: 0, message: 'queue empty' }
//   - { processed: N, counts: { triaged, fin_skip, failed, triage_raced, ... }, outcomes: [...] }
//
// Returns { msg, kind } where kind ∈ { 'success', 'warn', 'error' }.
function buildWorkerToast(resp) {
  if (!resp || typeof resp !== 'object') {
    return { msg: 'Worker returned no response.', kind: 'error' };
  }
  // `processed | 0` coerces undefined / null / non-numbers to 0.
  const processed = resp.processed | 0;
  if (processed === 0) {
    return { msg: 'No pending tasks to triage.', kind: 'success' };
  }
  const counts = (resp.counts && typeof resp.counts === 'object') ? resp.counts : {};
  const parts = [];
  if (counts.triaged)      parts.push(counts.triaged + ' triaged');
  if (counts.fin_skip)     parts.push(counts.fin_skip + ' Fin-skipped');
  if (counts.failed)       parts.push(counts.failed + ' failed');
  if (counts.triage_raced) parts.push(counts.triage_raced + ' raced');
  const detail = parts.length > 0 ? ' (' + parts.join(', ') + ')' : '';
  const noun = processed === 1 ? 'task' : 'tasks';
  return {
    msg: 'Triaged ' + processed + ' ' + noun + detail + '.',
    // Any failure should escalate the toast from success → warn so
    // the user notices that not every row went through cleanly.
    kind: (counts.failed > 0) ? 'warn' : 'success',
  };
}

// Node export hook — no-op in the browser. Lets the test suite
// require this file without dragging in tasking.js (which expects
// a browser environment to exist).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildWorkerToast };
}
