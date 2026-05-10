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
// Expected invocation (server-side only, same-origin):
//   POST /.netlify/functions/bask
//   { triage_id, response_text, thread_external_id? }
//
// Returns { success, bask_message_id } on success, { error } otherwise.

const BASK_API_URL = process.env.BASK_API_URL;
const BASK_API_KEY = process.env.BASK_API_KEY;

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

  // Real call goes here once the Bask contract is documented. Sketch:
  //   const r = await fetch(`${BASK_API_URL}/messages`, {
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
