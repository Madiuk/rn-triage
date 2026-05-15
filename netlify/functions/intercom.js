// netlify/functions/intercom.js
//
// Channel adapter: Intercom. INBOUND ONLY in this iteration —
// receives Intercom webhooks for new user messages and replies,
// verifies the signature, extracts the patient message, and inserts
// a query_history row with source_channel='intercom' and status=
// 'pending'. The worker (worker.js, currently stubbed) will pick up
// pending rows and run triage. Outbound replies back to the
// Intercom conversation are deferred until the worker + staff queue
// workflow is wired up; that'll add a `sendOutbound` path here,
// mirroring the stub in bask.js.
//
// Tenant identification (single-tenant trial):
//   Reads INTERCOM_TENANT_COMPANY_ID env var. When multi-tenant
//   Phase 4 lands, the webhook URL would be tenant-keyed (e.g.
//   /intercom/<tenant-slug>) and we'd resolve tenant from the path.
//
// Supported event topics (everything else is acknowledged with 200
// so Intercom doesn't retry):
//   conversation.user.created — initial user message in a new
//     conversation. Body is in data.item.source.body.
//   conversation.user.replied — user reply on an existing
//     conversation. New content is the most-recent user-authored
//     entry in data.item.conversation_parts.conversation_parts[].
//
// Idempotency: every Intercom message gets external_id
// "intercom:<conversation_id>:<part_or_source_id>". This means:
//   - Webhook retries (Intercom retries on 5xx) dedup via the
//     existing unique (company_id, external_id) index on
//     query_history. Caller gets 200 with duplicate=true.
//   - Multiple replies on the same conversation don't collide
//     because each gets a unique part id.
//   - When outbound replies land later, they can parse the
//     conversation_id back out to know where to post.
//
// ─────────────────────────────────────────────────────────────────
// TODO (when worker auto-triage lands — i.e. when this adapter
//       moves from "store inbound" to "store inbound + call
//       triage with full conversation history"):
//
//   1. PULL THE FULL THREAD, NOT JUST THE INBOUND PART. The
//      current handler only persists the new user message. When
//      the worker calls triage, it must fetch the full
//      conversation from Intercom (GET /conversations/<id>) and
//      walk every part chronologically. The patient may have a
//      long back-and-forth history that the AI needs to see so
//      it doesn't re-ask questions already answered or re-give
//      advice already given (the v0.3.16 bug, fixed for manual
//      entry by the priorInput → priorTurns refactor in
//      v0.3.17).
//
//   2. MAP AUTHOR TYPES → SPEAKER LABELS AND SERIALIZE TO THE
//      SAME FORMAT THE MANUAL UI PRODUCES. Map
//      author.type === 'user' → 'Patient',
//      author.type === 'admin' → 'Nurse' (or 'Other' for bots
//      / non-clinical staff if we want that resolution).
//      Emit one line per turn:
//          Patient: "<plain text>"
//          Nurse: "<plain text>"
//      identical to what serializePriorTurns() in app.js
//      produces. The triage proxy doesn't need any contract
//      change — it already takes a free-form string in
//      messages[0].content. One serialization format, two
//      ingestion paths (manual UI + adapter).
//
//   3. TRIM POLICY — DON'T SHIP UNBOUNDED HISTORY. A patient
//      with a 6-month Intercom thread could ship a 50K-token
//      prior block on every triage. Token cost is linear in
//      input size, latency scales with it, and a year-old turn
//      is mostly noise for triaging today's question.
//
//      Default: keep the last 10 turns OR the last ~4000 tokens
//      (whichever cuts more aggressively). Tunable per tenant
//      via a column on `companies` when we add it. Implement as
//      a pure helper `trimPriorTurns(turns, policy)` so it's
//      testable in isolation.
//
//   4. DO NOT PROMOTE PRIOR CONTEXT INTO THE CACHED PREFIX.
//      Anthropic prompt caching hashes the prefix (the system
//      messages with cache_control:ephemeral). BASE_PROMPT +
//      KB sit in that cached region today. Prior context lives
//      in the user-content block AFTER the cached prefix —
//      keep it there. Moving prior context into the cached
//      portion would murder cache hit rates because every
//      patient has a unique history. If a refactor ever moves
//      it up the prompt structure, that's a regression.
//
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const INTERCOM_WEBHOOK_SECRET = process.env.INTERCOM_WEBHOOK_SECRET;
const INTERCOM_TENANT_COMPANY_ID = process.env.INTERCOM_TENANT_COMPANY_ID;

// ── Pure helpers (exported for tests) ──────────────────────────────

// Verify Intercom's webhook signature. Intercom signs the raw request
// body with HMAC using the configured webhook secret. The signature
// arrives in X-Hub-Signature (sha1=...) or X-Hub-Signature-256
// (sha256=...). Timing-safe comparison defends against side-channel
// timing attacks.
function verifyIntercomSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  let algo, expectedHex;
  if (signature.startsWith('sha256=')) {
    algo = 'sha256';
    expectedHex = signature.slice('sha256='.length);
  } else if (signature.startsWith('sha1=')) {
    algo = 'sha1';
    expectedHex = signature.slice('sha1='.length);
  } else {
    return false;
  }
  let computedBuf, expectedBuf;
  try {
    expectedBuf = Buffer.from(expectedHex, 'hex');
    computedBuf = crypto.createHmac(algo, secret).update(rawBody).digest();
  } catch (e) {
    return false;
  }
  if (expectedBuf.length !== computedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(expectedBuf, computedBuf);
  } catch (e) {
    return false;
  }
}

// Strip Intercom's HTML formatting. Intercom wraps message content in
// rich-text HTML (<p>, <br>, <a>, etc.); the AI needs plain text. We
// preserve paragraph breaks as newlines, collapse extra whitespace,
// and decode common entities. Anything we don't recognize stays
// intact — this is deliberately conservative; we'd rather pass through
// some markup than mangle the message.
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    // Paragraph + div breaks render as a blank line — they're
    // semantic paragraph separators in Intercom's rich text.
    .replace(/<\/(p|div)>/gi, '\n\n')
    // List items get single newlines so list content stays compact.
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Pull the new user message + ids out of an Intercom webhook payload.
// Returns null for unsupported topics or payloads that don't carry a
// new user message. The handler treats null as "ignore quietly with
// 200" so Intercom won't retry events we deliberately skip.
function extractMessage(payload) {
  if (!payload) return null;
  const topic = payload.topic;
  const item = payload.data && payload.data.item;
  if (!item) return null;
  const conversationId = item.id;

  if (topic === 'conversation.user.created') {
    const source = item.source || {};
    return {
      conversationId,
      partId: source.id || conversationId,
      messageHtml: source.body || '',
      authorEmail: (source.author && source.author.email) || null,
      authorName: (source.author && source.author.name) || null,
    };
  }

  if (topic === 'conversation.user.replied') {
    const parts = (item.conversation_parts && item.conversation_parts.conversation_parts) || [];
    // The new user reply is the most-recent user-authored part.
    // Walk backwards so we find it even if Intercom batched
    // multiple parts (rare but possible).
    let lastUserPart = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p && p.author && p.author.type === 'user') {
        lastUserPart = p;
        break;
      }
    }
    if (!lastUserPart) return null;
    return {
      conversationId,
      partId: lastUserPart.id,
      messageHtml: lastUserPart.body || '',
      authorEmail: (lastUserPart.author && lastUserPart.author.email) || null,
      authorName: (lastUserPart.author && lastUserPart.author.name) || null,
    };
  }

  return null;
}

// ── Handler ────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!SUPABASE_URL || !(SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }
  if (!INTERCOM_WEBHOOK_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'INTERCOM_WEBHOOK_SECRET not configured' }) };
  }
  if (!INTERCOM_TENANT_COMPANY_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'INTERCOM_TENANT_COMPANY_ID not configured' }) };
  }

  // TODO (audit log): Before Intercom webhooks process real production
  // traffic, capture the raw payload to inbound_raw_event BEFORE
  // parsing — for replay/debug/audit. Deferred while vendor traffic
  // isn't live yet (designing the table now would be blind to actual
  // payload shapes). See memory: project_audit_log_deferred.
  //
  // Verify signature against the raw body. Netlify passes
  // event.body as a string; pass it directly to the HMAC.
  const rawBody = event.body || '';
  const headers = event.headers || {};
  const signature = headers['x-hub-signature-256']
    || headers['X-Hub-Signature-256']
    || headers['x-hub-signature']
    || headers['X-Hub-Signature']
    || '';
  if (!verifyIntercomSignature(rawBody, signature, INTERCOM_WEBHOOK_SECRET)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid webhook signature' }) };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // Ack-with-200 for topics we don't act on. Intercom only retries
  // 5xx and connection errors; returning 200 with `ignored: true`
  // lets them tick the webhook off as delivered while we deliberately
  // skip non-user-message events.
  const topic = payload.topic;
  const SUPPORTED = ['conversation.user.created', 'conversation.user.replied'];
  if (!SUPPORTED.includes(topic)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, topic: topic || null }),
    };
  }

  const msg = extractMessage(payload);
  if (!msg) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, reason: 'no user message in payload' }),
    };
  }

  const text = stripHtml(msg.messageHtml);
  if (!text) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, reason: 'empty message after html strip' }),
    };
  }

  const writeKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  const h = {
    'Content-Type': 'application/json',
    'apikey': writeKey,
    'Authorization': 'Bearer ' + writeKey,
    'Prefer': 'return=representation',
  };

  const externalId = `intercom:${msg.conversationId}:${msg.partId}`;
  const companyId = INTERCOM_TENANT_COMPANY_ID;

  // Idempotency. The unique (company_id, external_id) index on
  // query_history is the backstop if this check races a duplicate
  // delivery; the second insert would 409 and we'd catch it below.
  try {
    const dupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history?company_id=eq.${companyId}&external_id=eq.${encodeURIComponent(externalId)}&select=id,status&limit=1`,
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
  } catch (e) {
    console.error('intercom.dupCheck:', e.message);
    // Fall through; unique index serves as the backstop.
  }

  // Insert pending row. Worker fills in classification + draft after
  // the AI call. We deliberately leave clinical_category /
  // urgency_score / etc. NULL — those are AI outputs the worker
  // produces. nurse_name is set to the patient's name for now since
  // we don't yet have a real "system actor" concept; it makes the
  // origin obvious when looking at history.
  const record = {
    company_id: companyId,
    patient_message: text,
    source_channel: 'intercom',
    external_id: externalId,
    status: 'pending',
    urgency_original: 'routine',           // worker overrides post-triage
    non_clinical_flag: false,
    non_clinical_items: [],
    follow_up_questions: [],
    draft_response: '',
    nurse_name: msg.authorName || 'Intercom',
  };

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/query_history`, {
      method: 'POST', headers: h,
      body: JSON.stringify(record),
    });
    const result = await insertRes.json();

    if (!insertRes.ok || !Array.isArray(result) || !result[0]) {
      console.error('intercom.insertFailed:', insertRes.status, JSON.stringify(result).slice(0, 300));
      return {
        statusCode: insertRes.ok ? 502 : insertRes.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: 'Failed to queue task. Intercom retry is safe — external_id dedupes.',
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
        intercom_conversation_id: msg.conversationId,
      }),
    };
  } catch (e) {
    console.error('intercom.insert:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Insert failed' }),
    };
  }
};

// Re-export pure helpers for tests. The runtime handler is still the
// authoritative `exports.handler` above; these are additive properties
// on the same `module.exports`.
exports.verifyIntercomSignature = verifyIntercomSignature;
exports.stripHtml = stripHtml;
exports.extractMessage = extractMessage;
