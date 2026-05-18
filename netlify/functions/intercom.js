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
// No-DELETE policy:
//   Care Station never initiates destructive operations on clinical
//   conversations. This file is inbound-only today; when outbound is
//   added (Week 3 ROADMAP), the outbound surface must NOT include
//   DELETE /conversations/{id} or any equivalent. Incoming deletion
//   events (conversation_part.redacted, message.deleted) are
//   observations of upstream UI actions — if we later choose to
//   reflect them in local state, that's still observation, not
//   initiation.
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
const { logError } = require('./_lib/log');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const INTERCOM_WEBHOOK_SECRET = process.env.INTERCOM_WEBHOOK_SECRET;
const INTERCOM_TENANT_COMPANY_ID = process.env.INTERCOM_TENANT_COMPANY_ID;
// Optional: enables thread backfill on first sight of a conversation
// (Phase A — 2026-05-17). If unset, the webhook still processes
// inbound messages correctly; only the historical-context fetch is
// skipped. Logging surfaces the skip so ops can spot it.
const INTERCOM_ACCESS_TOKEN = process.env.INTERCOM_ACCESS_TOKEN;
const INTERCOM_API_VERSION = '2.11';

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

// Extract the Bask patient identifier from an Intercom webhook payload.
// Bask creates Intercom contacts with the patient's Bask ID written
// into the contact-level external_id field (Intercom's name for it,
// not ours — see migration 0034 for the naming rationale). Every
// webhook ships this at data.item.contacts.contacts[0].external_id;
// we pull it once at insert time and persist as bask_patient_id on
// query_history so the SPA can render an admin link without an API
// round-trip.
//
// Returns null when the field is absent (e.g., a non-Bask Intercom
// conversation, or an older payload before Bask was wired in).
function extractBaskPatientId(payload) {
  if (!payload) return null;
  const item = payload.data && payload.data.item;
  if (!item) return null;
  const contacts = item.contacts && item.contacts.contacts;
  if (!Array.isArray(contacts) || !contacts[0]) return null;
  const ext = contacts[0].external_id;
  return (typeof ext === 'string' && ext.trim()) ? ext.trim() : null;
}

// Extract the Intercom contact id from a webhook payload. Distinct
// from extractBaskPatientId: that returns the contact's external_id
// (Bask's identifier); this returns Intercom's own id for the
// contact, which is the key needed to call GET /contacts/{id}. We
// persist it as query_history.intercom_contact_id (mig 0035) so the
// per-conversation enrichment + the one-off backfill don't have to
// search by external_id.
function extractIntercomContactId(payload) {
  if (!payload) return null;
  const item = payload.data && payload.data.item;
  if (!item) return null;
  const contacts = item.contacts && item.contacts.contacts;
  if (!Array.isArray(contacts) || !contacts[0]) return null;
  const id = contacts[0].id;
  return (typeof id === 'string' && id.trim()) ? id.trim() : null;
}

// Extract Bask's Master ID from an Intercom contact API response (the
// JSON returned by GET /contacts/{id}). Bask writes it into
// custom_attributes under the key "order id" — lowercase, with a
// space (Intercom's naming quirk; not a typo on our side). The value
// is a UUID; Bask uses it for the admin/orders/<id> URL pattern. See
// migration 0035 for the schema and project memory
// "Bask data available via Intercom contact" for the discovery
// notes.
function extractBaskOrderMasterId(intercomContact) {
  if (!intercomContact || !intercomContact.custom_attributes) return null;
  const v = intercomContact.custom_attributes['order id'];
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
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
  const baskPatientId = extractBaskPatientId(payload);
  const intercomContactId = extractIntercomContactId(payload);

  if (topic === 'conversation.user.created') {
    const source = item.source || {};
    return {
      conversationId,
      partId: source.id || conversationId,
      messageHtml: source.body || '',
      authorEmail: (source.author && source.author.email) || null,
      authorName: (source.author && source.author.name) || null,
      baskPatientId,
      intercomContactId,
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
      baskPatientId,
      intercomContactId,
    };
  }

  return null;
}

// Coalescing window — how long a freshly-created primary task waits
// before becoming visible in the queue. Additional messages on the
// same conversation that arrive during this window attach as follow-on
// rows to the primary instead of spawning their own queue task. See
// migration 0033 for the schema; queue.js for the read-time filter
// that enforces visibility; worker-background.js for the
// severity-bypass that can clear surface_at early.
const HOLD_WINDOW_MS = 5 * 60 * 1000;

// Decide the coalescing fields for a new inbound row.
//
//   existingOpenPrimaryId: id of an open primary task on this
//     conversation, or null/undefined if there is none.
//   nowMs: Date.now() at the insert site. Passed explicitly so this
//     helper stays pure and the timer is testable.
//
// Returns one of two shapes, in both cases set both keys so the
// caller can spread the result onto the record without worrying
// about which case it's in:
//   * { primary_task_id: <id>,  surface_at: null }          — follow-on
//   * { primary_task_id: null,  surface_at: <ISO string> }  — primary
function buildCoalescingFields(existingOpenPrimaryId, nowMs) {
  if (existingOpenPrimaryId) {
    return { primary_task_id: existingOpenPrimaryId, surface_at: null };
  }
  return {
    primary_task_id: null,
    surface_at: new Date(nowMs + HOLD_WINDOW_MS).toISOString(),
  };
}

// Intercom-emitted system placeholder bodies. These are NOT real
// patient text — Intercom inserts them when a conversation.user.created
// event fires without an actual typed message (button-initiated
// conversations, certain Messenger entry points, API-initiated chats).
// Letting them through wastes Anthropic spend on triaging an empty
// message + pollutes the staff queue with rows whose AI draft is
// always "your message didn't come through." Observed 2026-05-17:
// 9 of 12 inbound rows from one morning matched this exact body.
//
// Match is exact-string (after trim). If Intercom changes the
// wording, this filter no-ops and we'd see junk rows again — at
// which point we add the new pattern. Better than a fuzzy regex
// that could swallow real short messages from patients.
const INTERCOM_SYSTEM_PLACEHOLDERS = new Set([
  'SYSTEM MESSAGE: CONVERSATION STARTED',
]);

function isSystemPlaceholder(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;  // empty bodies are handled by the earlier `if (!text)` branch
  return INTERCOM_SYSTEM_PLACEHOLDERS.has(trimmed);
}

// Fire-and-forget audit writer for inbound_raw_event (mig 0024).
// Every event that makes it past signature verification gets a row,
// regardless of whether it produces a query_history insert. Lets us
// answer "what is Intercom sending us" + "why did we ignore this"
// retroactively without needing to deploy diagnostic logging.
//
// Best-effort: if the audit insert fails, the handler continues so
// real inbound processing isn't blocked by an audit-table outage.
// The error is logged via the structured logger for ops visibility.
async function auditInbound(h, fields) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/inbound_raw_event`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        company_id: fields.company_id || null,
        source_channel: fields.source_channel || 'intercom',
        topic: fields.topic || null,
        external_id: fields.external_id || null,
        raw_payload: fields.raw_payload || null,
        processed: !!fields.processed,
        processed_reason: fields.processed_reason || null,
        triage_id: fields.triage_id || null,
      }),
    });
  } catch (e) {
    logError('intercom.audit_inbound_failed', e);
  }
}

// Pull the Fin (Intercom AI Agent) participation flag from a webhook
// payload. Strict-equals on `true` so missing field, undefined, null,
// 0, '' all return false safely. When true, the handler logs a
// high-visibility warning and persists fin_participated on the
// inserted row; the worker uses that flag to route the task to human
// review instead of running Care Station's AI on top of Fin's output.
function isAiAgentParticipated(payload) {
  if (!payload || !payload.data || !payload.data.item) return false;
  return payload.data.item.ai_agent_participated === true;
}

// Extract the conversation_id portion of an Intercom-shaped external_id.
// Format: "intercom:<conv_id>:<part_id>" → returns <conv_id>, or null
// if the input doesn't match. Used both at insert time (where we
// already have conversationId from the payload, so this is the
// fallback) and by the migration 0028 backfill UPDATE.
function extractConversationIdFromExternalId(externalId) {
  if (typeof externalId !== 'string') return null;
  const m = /^intercom:([^:]+):/.exec(externalId);
  return m ? m[1] : null;
}

// Turn an Intercom conversation API response into the list of historical
// rows we want to insert. Pure for testing.
//
// Inputs:
//   intercomConv  — the JSON body returned by GET /conversations/<id>
//   companyId     — tenant company_id to stamp on each row
//   skipPartId    — the part id of the message we just inserted via the
//                   webhook (so the backfill doesn't double-write it)
//
// Output: array of records ready to POST to query_history. Sorted by
//   created_at ascending so the thread view renders in time order.
//   - user-authored parts → patient_message set, actual_response_sent null
//   - admin-authored parts → patient_message null, actual_response_sent set
//   - parts with empty/whitespace body → skipped
//   - parts whose id matches skipPartId → skipped
//
// All rows get status='closed' (terminal; won't be picked up by the
// worker or the queue pull) and a backfill breadcrumb in internal_note
// so future readers can tell which rows came from this code path.
function buildBackfillRecords(intercomConv, companyId, skipPartId) {
  if (!intercomConv || !intercomConv.id) return [];
  const conversationId = intercomConv.id;
  const parts = [];

  // The `source` object on a conversation is the very first message
  // (typically the user-created event). Treat it like any other part.
  if (intercomConv.source && intercomConv.source.body) {
    parts.push({
      id: intercomConv.source.id || conversationId,
      body: intercomConv.source.body,
      authorType: intercomConv.source.author && intercomConv.source.author.type,
      authorName: intercomConv.source.author && intercomConv.source.author.name,
      authorEmail: intercomConv.source.author && intercomConv.source.author.email,
      createdAt: intercomConv.created_at,
    });
  }

  const cp = intercomConv.conversation_parts && intercomConv.conversation_parts.conversation_parts;
  if (Array.isArray(cp)) {
    for (const p of cp) {
      if (!p || !p.id) continue;
      if (!p.body) continue;  // assignment / system parts have no body
      parts.push({
        id: p.id,
        body: p.body,
        authorType: p.author && p.author.type,
        authorName: p.author && p.author.name,
        authorEmail: p.author && p.author.email,
        createdAt: p.created_at,
      });
    }
  }

  // Sort ascending so the records insert in time order.
  parts.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const backfillBreadcrumb =
    'BACKFILLED from Intercom on ' + new Date().toISOString() + '. ' +
    'Historical context for thread view; not part of the active queue.';

  const records = [];
  for (const part of parts) {
    if (part.id === skipPartId) continue;
    const clean = stripHtml(part.body).trim();
    if (!clean) continue;
    if (isSystemPlaceholder(clean)) continue;

    const isUser = part.authorType === 'user';
    const externalId = 'intercom:' + conversationId + ':' + part.id;
    const createdAt = part.createdAt
      ? new Date(part.createdAt * 1000).toISOString()
      : null;

    const record = {
      company_id: companyId,
      source_channel: 'intercom',
      external_id: externalId,
      conversation_id: conversationId,
      status: 'closed',
      internal_note: backfillBreadcrumb,
    };
    if (createdAt) record.created_at = createdAt;

    if (isUser) {
      record.patient_message = clean;
      // patient_name + patient_email (migration 0029) — surface the
      // patient's identity for the SPA's detail-view top bar and any
      // future EHR-matching surfaces.
      if (part.authorName) record.patient_name = part.authorName;
      if (part.authorEmail) record.patient_email = part.authorEmail;
    } else {
      // Admin (staff) authored. patient_message stays NULL; the staff
      // text is the actual_response_sent so the thread renders it as
      // a staff bubble. nurse_name correctly captures the staff
      // member's identity here.
      record.actual_response_sent = clean;
      record.nurse_name = part.authorName || 'Intercom admin';
    }
    records.push(record);
  }
  return records;
}

// Re-sync conversation parts from Intercom on every
// conversation.user.replied webhook. Fire-and-forget — the webhook's
// primary job (insert the current event) succeeds independently.
// Failures here are logged and the audit row is updated with the
// outcome, but do NOT propagate to Intercom.
//
// Triggered when:
//   * INTERCOM_ACCESS_TOKEN is set (otherwise we have no API access)
//   * The current event is conversation.user.replied (a fresh
//     conversation.user.created can't have prior parts by definition)
//
// Why every reply, not just first sight (changed 2026-05-18): admin-
// authored parts (replies posted into Intercom by Bask, native
// Intercom, or any future channel) do not reliably fire
// conversation.admin.replied webhooks to our endpoint — observed
// Bask integration writes that landed in the Intercom conversation
// but produced zero admin webhooks in inbound_raw_event. Re-syncing
// on every patient reply guarantees admin parts that landed between
// turns get persisted into query_history so they appear in the
// chat-log render. Cost: one extra GET /conversations/<id> call per
// inbound user reply (negligible at single-tenant volumes).
//
// Best-effort idempotency: each insert uses
// `Prefer: resolution=ignore-duplicates` so a concurrent webhook
// inserting the same part doesn't 409 us; the unique
// (company_id, external_id) partial index from migration 0001 is the
// conflict target. With re-sync on every reply, the
// ignore-duplicates path is the common case, not the exception.
async function backfillIntercomThread(h, ctx) {
  const { topic, conversationId, currentPartId, companyId } = ctx;
  if (!INTERCOM_ACCESS_TOKEN) {
    logError('intercom.backfill.skipped', null, {
      reason: 'INTERCOM_ACCESS_TOKEN not set',
      conversation_id: conversationId,
    });
    return;
  }
  if (topic === 'conversation.user.created') {
    // Brand-new conversation; no prior parts to fetch.
    return;
  }

  // Fetch the full conversation from Intercom.
  let intercomConv;
  try {
    const r = await fetch(
      'https://api.intercom.io/conversations/' + encodeURIComponent(conversationId),
      {
        headers: {
          'Authorization': 'Bearer ' + INTERCOM_ACCESS_TOKEN,
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION,
        },
      }
    );
    if (!r.ok) {
      logError('intercom.backfill.fetch_failed', null, {
        status: r.status,
        conversation_id: conversationId,
      });
      return;
    }
    intercomConv = await r.json();
  } catch (e) {
    logError('intercom.backfill.fetch_exception', e, { conversation_id: conversationId });
    return;
  }

  const records = buildBackfillRecords(intercomConv, companyId, currentPartId);
  if (records.length === 0) return;

  // Idempotent insert. Prefer: resolution=ignore-duplicates uses the
  // unique partial index on (company_id, external_id) as the
  // conflict target. Already-present rows are silently skipped.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/query_history`, {
      method: 'POST',
      headers: {
        ...h,
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(records),
    });
  } catch (e) {
    logError('intercom.backfill.insert', e, {
      conversation_id: conversationId,
      record_count: records.length,
    });
  }
}

// Fire-and-forget enrichment: fetch the Intercom contact for a freshly
// inserted query_history row and persist Bask's Master ID
// (custom_attributes["order id"]) on the row. Skipped silently when
// INTERCOM_ACCESS_TOKEN is unset or the contact id is missing — the
// row's own classification path doesn't depend on this; the master
// id only drives a UI deep-link.
//
// Per-conversation scope: only enrich primary rows (follow-on rows
// already share the conversation's master id via the primary record).
// Called from the handler after a successful insert.
async function enrichBaskMasterId(h, ctx) {
  const { contactId, triageId, conversationId } = ctx;
  if (!INTERCOM_ACCESS_TOKEN) {
    logError('intercom.enrich.skipped', null, {
      reason: 'INTERCOM_ACCESS_TOKEN not set',
      conversation_id: conversationId,
    });
    return;
  }
  if (!contactId || !triageId) return;

  let contact;
  try {
    const r = await fetch(
      'https://api.intercom.io/contacts/' + encodeURIComponent(contactId),
      {
        headers: {
          'Authorization': 'Bearer ' + INTERCOM_ACCESS_TOKEN,
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION,
        },
      }
    );
    if (!r.ok) {
      logError('intercom.enrich.fetch_failed', null, {
        status: r.status,
        contact_id: contactId,
      });
      return;
    }
    contact = await r.json();
  } catch (e) {
    logError('intercom.enrich.fetch_exception', e, { contact_id: contactId });
    return;
  }

  const masterId = extractBaskOrderMasterId(contact);
  if (!masterId) return;

  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/query_history?id=eq.${encodeURIComponent(triageId)}`,
      {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ bask_master_id: masterId }),
      }
    );
  } catch (e) {
    logError('intercom.enrich.patch_failed', e, { triage_id: triageId });
  }
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

  // Verify signature against the raw body. Netlify passes
  // event.body as a string; pass it directly to the HMAC. Signature
  // failures are NOT captured to inbound_raw_event — that table is
  // for events that crossed the trusted boundary, and storing
  // arbitrary attacker payloads has no upside. The structured
  // logger surfaces signature failures for ops monitoring.
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

  // Construct service-key headers now so every audit path can use them.
  // 'return=representation' is the default; auditInbound overrides to
  // 'return=minimal' for its own writes.
  const writeKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  const h = {
    'Content-Type': 'application/json',
    'apikey': writeKey,
    'Authorization': 'Bearer ' + writeKey,
    'Prefer': 'return=representation',
  };

  // Common context for every audit row written from this request.
  // The handler appends `external_id` / `processed` / `processed_reason`
  // / `triage_id` per branch.
  const topic = payload.topic;
  const auditBase = {
    company_id: INTERCOM_TENANT_COMPANY_ID,
    source_channel: 'intercom',
    topic: topic,
    raw_payload: payload,
  };

  // Ack-with-200 for topics we don't act on. Intercom only retries
  // 5xx and connection errors; returning 200 with `ignored: true`
  // lets them tick the webhook off as delivered while we deliberately
  // skip non-user-message events.
  const SUPPORTED = ['conversation.user.created', 'conversation.user.replied'];
  if (!SUPPORTED.includes(topic)) {
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'unsupported_topic' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, topic: topic || null }),
    };
  }

  const msg = extractMessage(payload);
  if (!msg) {
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'no_user_message' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, reason: 'no user message in payload' }),
    };
  }

  const externalId = `intercom:${msg.conversationId}:${msg.partId}`;

  const text = stripHtml(msg.messageHtml);
  if (!text) {
    await auditInbound(h, { ...auditBase, external_id: externalId, processed: false, processed_reason: 'empty_after_strip' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, reason: 'empty message after html strip' }),
    };
  }
  if (isSystemPlaceholder(text)) {
    logError('intercom.system_placeholder_skipped', null, {
      topic: topic,
      intercom_conversation_id: msg.conversationId,
      body_preview: text.slice(0, 80),
    });
    await auditInbound(h, { ...auditBase, external_id: externalId, processed: false, processed_reason: 'system_placeholder' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, reason: 'system_placeholder' }),
    };
  }

  // Fin defense: if Intercom's AI Agent participated in this
  // conversation, log it high-visibility and flag the row. The worker
  // sees fin_participated=true and routes to human review instead of
  // running Care Station's AI on top of Fin's output. Fin is dormant
  // in this workspace today, so any occurrence here means the
  // workspace configuration has changed and we want to know about it.
  const finFlag = isAiAgentParticipated(payload);
  if (finFlag) {
    logError('intercom.fin_participated', null, {
      topic: topic,
      intercom_conversation_id: msg.conversationId,
    });
  }

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
      await auditInbound(h, {
        ...auditBase,
        external_id: externalId,
        processed: false,
        processed_reason: 'duplicate',
        triage_id: dupes[0].id,
      });
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
    logError('intercom.dupCheck', e);
    // Fall through; unique index serves as the backstop.
  }

  // Coalescing lookup (migration 0033). If an open primary already
  // exists on this conversation, this row attaches as a follow-on
  // (primary_task_id set, no surface_at). Otherwise this row IS the
  // primary and gets a 5-minute hold window (surface_at set). Lookup
  // failure falls back to "treat as primary" — silent data drop is
  // worse than an extra task row.
  let existingOpenPrimaryId = null;
  try {
    const lookupUrl = `${SUPABASE_URL}/rest/v1/query_history`
      + `?company_id=eq.${encodeURIComponent(companyId)}`
      + `&conversation_id=eq.${encodeURIComponent(msg.conversationId)}`
      + `&primary_task_id=is.null`
      + `&status=in.("pending","triaged","reviewed","patient_replied")`
      + `&select=id`
      + `&order=created_at.asc&limit=1`;
    const lookupRes = await fetch(lookupUrl, { headers: h });
    if (lookupRes.ok) {
      const rows = await lookupRes.json();
      if (Array.isArray(rows) && rows[0] && rows[0].id) {
        existingOpenPrimaryId = rows[0].id;
      }
    } else {
      logError('intercom.coalesce_lookup_failed', null, {
        status: lookupRes.status,
        conversation_id: msg.conversationId,
      });
    }
  } catch (e) {
    logError('intercom.coalesce_lookup_exception', e, {
      conversation_id: msg.conversationId,
    });
  }
  const coalescing = buildCoalescingFields(existingOpenPrimaryId, Date.now());

  // Insert pending row. Worker fills in classification + draft after
  // the AI call. We deliberately leave clinical_category /
  // urgency_score / etc. NULL — those are AI outputs the worker
  // produces.
  //
  // conversation_id (migration 0028) groups every row in the same
  // Intercom conversation so the tasking SPA's detail view can render
  // the full thread.
  //
  // patient_email / patient_name (migration 0029) record who the
  // patient is, surfaced in the SPA and used downstream for EHR
  // matching. nurse_name is NOT set on patient-side inbound rows —
  // that column is for the staff member who handles the row, not the
  // patient. The legacy code that mis-used it is replaced by these
  // dedicated columns.
  //
  // primary_task_id / surface_at (migration 0033) implement the
  // 5-minute hold + conversation coalescing rule. See
  // buildCoalescingFields above.
  const record = {
    company_id: companyId,
    patient_message: text,
    source_channel: 'intercom',
    external_id: externalId,
    conversation_id: msg.conversationId,
    patient_email: msg.authorEmail || null,
    patient_name: msg.authorName || null,
    status: 'pending',
    urgency_original: 'routine',           // worker overrides post-triage
    non_clinical_flag: false,
    non_clinical_items: [],
    follow_up_questions: [],
    draft_response: '',
    fin_participated: finFlag,
    primary_task_id: coalescing.primary_task_id,
    surface_at: coalescing.surface_at,
    bask_patient_id: msg.baskPatientId || null,
    intercom_contact_id: msg.intercomContactId || null,
  };

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/query_history`, {
      method: 'POST', headers: h,
      body: JSON.stringify(record),
    });
    const result = await insertRes.json();

    if (!insertRes.ok || !Array.isArray(result) || !result[0]) {
      logError('intercom.insertFailed', null, {
        status: insertRes.status,
        body: JSON.stringify(result).slice(0, 300),
      });
      await auditInbound(h, {
        ...auditBase,
        external_id: externalId,
        processed: false,
        processed_reason: 'insert_failed',
      });
      return {
        statusCode: insertRes.ok ? 502 : insertRes.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: 'Failed to queue task. Intercom retry is safe — external_id dedupes.',
        }),
      };
    }

    await auditInbound(h, {
      ...auditBase,
      external_id: externalId,
      processed: true,
      processed_reason: finFlag ? 'inserted_fin_participated' : 'inserted',
      triage_id: result[0].id,
    });

    // Fire-and-forget re-sync of conversation parts from Intercom.
    // Fires on every conversation.user.replied (not on .created,
    // which is by definition the first message). Catches admin parts
    // that landed since the prior sync — including replies posted
    // through Intercom by Bask or other channels whose admin webhooks
    // don't reach us. INTERCOM_ACCESS_TOKEN must be set; if not, the
    // helper logs the skip and returns. Idempotent via the unique
    // (company_id, external_id) partial index.
    backfillIntercomThread(h, {
      topic: topic,
      conversationId: msg.conversationId,
      currentPartId: msg.partId,
      companyId: companyId,
    }).catch(e => logError('intercom.backfill.unhandled', e));

    // Fire-and-forget enrichment of Bask Master ID. Only fire for
    // primary rows — follow-ons share the conversation's master id
    // via the primary they attach to (queue + detail view read the
    // primary's columns, not the follow-on's). Failures are logged
    // but don't propagate; the row's classification and the
    // patient-link UI both work without this enrichment.
    if (!coalescing.primary_task_id) {
      enrichBaskMasterId(h, {
        contactId: msg.intercomContactId,
        triageId: result[0].id,
        conversationId: msg.conversationId,
      }).catch(e => logError('intercom.enrich.unhandled', e));
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
    logError('intercom.insert', e);
    await auditInbound(h, {
      ...auditBase,
      external_id: externalId,
      processed: false,
      processed_reason: 'insert_exception',
    });
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
exports.isAiAgentParticipated = isAiAgentParticipated;
exports.isSystemPlaceholder = isSystemPlaceholder;
exports.extractConversationIdFromExternalId = extractConversationIdFromExternalId;
exports.extractBaskPatientId = extractBaskPatientId;
exports.extractIntercomContactId = extractIntercomContactId;
exports.extractBaskOrderMasterId = extractBaskOrderMasterId;
exports.buildBackfillRecords = buildBackfillRecords;
exports.buildCoalescingFields = buildCoalescingFields;
exports.INTERCOM_SYSTEM_PLACEHOLDERS = INTERCOM_SYSTEM_PLACEHOLDERS;
exports.HOLD_WINDOW_MS = HOLD_WINDOW_MS;
