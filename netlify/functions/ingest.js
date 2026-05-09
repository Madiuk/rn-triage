// Relai Ingest Endpoint — webhook/API stub
// Ready to receive automated inputs when Bask or other systems have webhook support
// Currently validates API key and creates a history record identical to manual triage

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const h = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Prefer': 'return=representation'
  };

  try {
    // Validate API key from header. Strip "Bearer " when callers send the
    // key in a standard Authorization header.
    const rawKey = event.headers['x-relai-api-key'] || event.headers['authorization'] || '';
    const apiKey = rawKey.replace(/^Bearer\s+/i, '').trim();
    if (!apiKey) return { statusCode: 401, body: JSON.stringify({ error: 'API key required. Send X-Relai-Api-Key header.' }) };

    // Look up company from API key (simple hash check)
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

    // Update last_used
    await fetch(`${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ last_used: new Date().toISOString() })
    });

    // Parse inbound message
    const body = JSON.parse(event.body || '{}');
    const { message, patient_id, channel = 'api', external_id } = body;
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'message field required' }) };

    // Create a pending history record (AI processing happens via triage endpoint)
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
      nurse_name: 'API Ingest'
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/query_history`, {
      method: 'POST', headers: h,
      body: JSON.stringify(record)
    });
    const result = await r.json();
    const taskId = Array.isArray(result) && result[0] ? result[0].id : null;

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        task_id: taskId,
        message: 'Task created. Use the Relai dashboard to process.'
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
