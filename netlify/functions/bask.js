// netlify/functions/bask.js
//
// Channel adapter: Bask Health (compounded-meds EHR — used by the
// Big Easy Weight Loss tenant). One of N pluggable channel adapters;
// see PLAN.md Phase 3 for the framework. Future adapters (email,
// Healthie, live chat, SMS, etc.) live alongside this one and
// eventually get reorganized under netlify/functions/channels/.
//
// Each channel adapter has two responsibilities:
//   1. Inbound — accept messages from the source and normalize them
//      into a query_history row (handled by ingest.js's generic
//      handler; channel-specific webhook signature verification will
//      live in this file once Bask publishes their contract).
//   2. Outbound — post the staff-approved reply back into the same
//      thread. This file is the outbound side; currently a stub.
//
// Stub status: the Bask API contract (auth, endpoint shape, payload
// format) is not yet known. The shape below matches the expected
// internal call site so the rest of the system (worker.js, queue UI)
// can be built against it.
//
// No-DELETE policy (load-bearing — do not soften):
//   Care Station never initiates destructive operations on Bask
//   clinical records. The outbound surface from this file MUST NOT
//   include DELETE on patients, orders, treatments, prescriptions,
//   notes, or any analogous Bask endpoint. Care Station's role is
//   triage and reply, not record management. This rule applies in
//   spirit beyond literal `DELETE` HTTP method: any PATCH/PUT that
//   would functionally remove or invalidate a record (e.g.,
//   `PATCH /prescriptions/{id}` with `{ status: 'cancelled' }`) is
//   equivalent and equally forbidden — the source of truth for those
//   actions is the clinician working in Bask's UI, not us.
//
//   The safeBaskFetch() wrapper below enforces this at runtime for
//   the literal-DELETE case (a belt-and-suspenders guard). Any future
//   real Bask API call from this file MUST go through safeBaskFetch
//   so the policy is enforced by code, not just by comment.
//
//   Incoming deletion events from Bask webhooks (record.deleted,
//   prescription.cancelled, etc.) are observations of upstream UI
//   actions — if we choose to reflect them in local state, that's
//   still observation, not initiation. Mirror, never originate.
//
// TODO (audit log): When Bask publishes their inbound webhook contract
// and we wire the inbound path here (or in ingest.js with channel=
// 'bask'), capture the raw payload to inbound_raw_event BEFORE parsing
// — for replay/debug/audit. Deferred while vendor isn't ready (designing
// the table now would be blind to actual payload shapes). See memory:
// project_audit_log_deferred.
//
// Expected invocation (server-side only, same-origin):
//   POST /.netlify/functions/bask
//   { triage_id, response_text, thread_external_id? }
//
// Returns { success, bask_message_id } on success, { error } otherwise.

const BASK_API_URL = process.env.BASK_API_URL;
const BASK_API_KEY = process.env.BASK_API_KEY;

// Disallowed methods for outbound Bask calls. DELETE is the literal
// destructive verb; PUT/PATCH on its own isn't forbidden (they're
// commonly used for additive writes like creating outbound messages),
// but a PATCH/PUT carrying a destructive payload IS forbidden — that
// case can't be detected from method alone, so it's enforced by the
// policy comment + code review.
const BASK_FORBIDDEN_METHODS = new Set(['DELETE']);

// safeBaskFetch — wrap every outbound Bask API call through this. The
// wrapper refuses any HTTP method in BASK_FORBIDDEN_METHODS, throwing
// a clear error instead of letting a destructive call slip through.
// This is the runtime half of the no-DELETE policy documented at the
// top of this file.
//
// Pure (no external state beyond the fetch call); exported for tests.
async function safeBaskFetch(url, opts) {
  const options = opts || {};
  const method = (options.method || 'GET').toUpperCase();
  if (BASK_FORBIDDEN_METHODS.has(method)) {
    throw new Error(
      'Bask no-DELETE policy: HTTP method ' + method + ' is not permitted '
      + 'from Care Station. See the policy header in netlify/functions/bask.js.'
    );
  }
  return fetch(url, options);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!BASK_API_URL || !BASK_API_KEY) {
    return {
      statusCode: 503,
      body: JSON.stringify({
        error: 'Bask integration not configured. Set BASK_API_URL and BASK_API_KEY.',
      }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const { triage_id, response_text, thread_external_id } = body;
  if (!triage_id || !response_text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'triage_id and response_text required' }) };
  }

  // Real call goes here once the Bask contract is documented. Sketch
  // (note: uses safeBaskFetch — every real call must, to keep the
  // no-DELETE policy enforceable):
  //   const r = await safeBaskFetch(`${BASK_API_URL}/messages`, {
  //     method: 'POST',
  //     headers: {
  //       'Authorization': `Bearer ${BASK_API_KEY}`,
  //       'Content-Type': 'application/json',
  //     },
  //     body: JSON.stringify({
  //       thread_id: thread_external_id,
  //       text: response_text,
  //       metadata: { relai_triage_id: triage_id },
  //     }),
  //   });
  //   const data = await r.json();
  //   if (!r.ok) return { statusCode: r.status, body: JSON.stringify({ error: data.message }) };
  //   return { statusCode: 200, body: JSON.stringify({ success: true, bask_message_id: data.id }) };

  return {
    statusCode: 501,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: 'Bask outbound not yet implemented.',
      stub: { triage_id, thread_external_id, response_length: response_text.length },
    }),
  };
};

// Re-export pure helpers for tests.
exports.safeBaskFetch = safeBaskFetch;
exports.BASK_FORBIDDEN_METHODS = BASK_FORBIDDEN_METHODS;
