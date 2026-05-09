// Relai Ingest Endpoint — webhook entry from EHR systems (Bask, etc.)
//
// Validates an API key, dedupes by (company_id, external_id), and
// creates a query_history row with status='pending'. The background
// worker (worker.js) picks up pending rows on a schedule and runs the
// triage. This endpoint never calls Anthropic itself — it must respond
// quickly so the EHR webhook doesn't time out.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const writeKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  const h = {
    'Content-Type': 'application/json',
    'apikey': writeKey,
    'Authorization': 'Bearer ' + writeKey,
    'Prefer': 'return=representation',
  };

  try {
    // Validate API key from header. Strip "Bearer " when callers send the
    // key in a standard Authorization header.
    const rawKey = event.headers['x-relai-api-key'] || event.headers['authorization'] || '';
    const apiKey = rawKey.replace(/^Bearer\s+/i, '').trim();
    if (!apiKey) {
      return { statusCode: 401, body: JSON.stringify({ error: 'API key required. Send X-Relai-Api-Key header.' }) };
    }

    const crypto = require('crypto');
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const keyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}&select=*`,
      { headers: h }
    );
    const keys = await keyRes.json();
    if (!Array.isArray(keys) || !keys[0]) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid API key' }) };
    }
    const { company_id } = keys[0];

    // Update last_used (fire-and-forget — don't block on this)
    fetch(`${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ last_used: new Date().toISOString() }),
    }).catch(e => console.error('ingest.touchKey:', e.message));

    // Parse the inbound payload
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const { message, patient_id, channel = 'api', external_id } = body;
    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'message field required' }) };
    }

    // Idempotency: if we've already seen this external_id for this
    // company, return the existing record. Webhook senders retry; we
    // must not double-process.
    if (external_id) {
      const dupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/query_history?company_id=eq.${company_id}&external_id=eq.${encodeURIComponent(external_id)}&select=id,status&limit=1`,
        { headers: h }
      );
      const dupes = await dupRes.json();
      if (Array.isArray(dupes) && dupes[0]) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            duplicate: true,
            task_id: dupes[0].id,
            status: dupes[0].status,
          }),
        };
      }
    }

    const record = {
      company_id,
      patient_message: message,
      source_channel: channel,
      external_id: external_id || null,
      status: 'pending',
      urgency_original: 'routine',
      non_clinical_flag: false,
      non_clinical_items: [],
      follow_up_questions: [],
      draft_response: '',
      nurse_name: 'API Ingest',
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/query_history`, {
      method: 'POST', headers: h,
      body: JSON.stringify(record),
    });
    const result = await r.json();
    const taskId = Array.isArray(result) && result[0] ? result[0].id : null;

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        task_id: taskId,
        status: 'pending',
        message: 'Task queued. Worker will process shortly.',
      }),
    };
  } catch (err) {
    console.error('ingest.handler:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
