// netlify/functions/bask.js
// Outbound proxy to Bask Health's EHR API. Stub — the real Bask API
// contract (auth, endpoint shape, payload format) is not yet known. The
// shape below matches the expected internal call site so the rest of
// the system can be built around it and swapped in when Bask is ready.
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
