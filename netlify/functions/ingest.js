// Relai Ingest Endpoint — generic inbound webhook for any channel.
//
// Channel-agnostic by design. Callers (channel adapters or any tenant
// integration) POST a JSON body with at minimum a `message` field and
// optionally a `channel` (defaults to 'api'), `external_id`,
// `patient_id`, etc. The handler validates the API key, dedupes by
// (company_id, external_id), and creates a query_history row with
// status='pending' and source_channel set to whatever the caller
// reported. Examples of expected channel ids:
//   'manual'    — staff paste in the SPA (handled elsewhere, not here)
//   'api'       — generic / unspecified caller (default)
//   'bask'      — Bask Health EHR webhook
//   'healthie'  — Healthie EHR webhook
//   'email'     — inbound email forwarded by Postmark/Mailgun
//   'sms'       — Twilio inbound SMS
//   'live_chat' — Intercom / Drift / similar
//   'web_form'  — practice's web contact form
// New channels add a new id; the handler doesn't change.
//
// The background worker (worker.js) picks up pending rows on a
// schedule and runs the triage. This endpoint never calls Anthropic
// itself — it must respond quickly so the upstream caller's webhook
// doesn't time out.

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
    if (!company_id) {
      // Defensive: api_keys.company_id is NOT NULL in the schema,
      // but if a key row somehow exists without one, refuse rather
      // than insert a query_history row with company_id=null.
      // company_id=null would orphan the row from tenant scoping —
      // worker.js would still process it, but it wouldn't appear in
      // any tenant's queue or aggregations.
      return { statusCode: 500, body: JSON.stringify({ error: 'API key has no company_id; contact admin.' }) };
    }

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

    // Honest success/failure. Earlier the handler returned 201
    // unconditionally with task_id=null on insert failure — meaning
    // a webhook sender's caller thought the message was queued
    // when it actually got dropped. Silent data loss for every
    // channel adapter we'll add in Phase 3. Now the response
    // status reflects what actually happened.
    if (!r.ok || !Array.isArray(result) || !result[0]) {
      console.error('ingest.insertFailed:', r.status, JSON.stringify(result).slice(0, 300));
      return {
        statusCode: r.ok ? 502 : r.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: 'Failed to queue task. Retry safe — external_id dedupes if you do.',
        }),
      };
    }

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        task_id: result[0].id,
        status: 'pending',
        message: 'Task queued. Worker will process shortly.',
      }),
    };
  } catch (err) {
    console.error('ingest.handler:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
