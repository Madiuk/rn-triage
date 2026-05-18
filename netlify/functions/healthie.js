// netlify/functions/healthie.js
//
// Channel adapter: Healthie (EHR / patient-portal — currently the
// primary source of patient conversations for the Big Easy tenant
// during the Bask migration; ~80% of inbound content as of
// 2026-05-18). Sibling to intercom.js and bask.js; same pluggable-
// adapter framework (PLAN.md Phase 3).
//
// ARCHITECTURAL NOTE — webhooks are PINGS, not payloads.
//
// Unlike Intercom (which ships the full message body in the webhook),
// Healthie's webhook payload is intentionally minimal — only:
//   { resource_id, resource_id_type, event_type, changed_fields }
//
// To extract the actual message content, sender, and recipient we
// must call Healthie's GraphQL API for the Note resource. That's
// what HEALTHIE_API_KEY is for. Without it, this handler audits
// every event to inbound_raw_event but cannot create query_history
// rows — there's nothing to put in them.
//
// Concretely: if HEALTHIE_API_KEY is unset, every webhook is logged
// as audit-only and 200-acks. When the key is added to Netlify env
// and the function redeploys, the same webhook starts producing real
// tasks. No backfill of missed events from the audit-only period —
// they exist in inbound_raw_event for forensic purposes but are not
// re-played.
//
// No-DELETE policy (load-bearing — do not soften):
//   Care Station never initiates destructive operations on Healthie
//   clinical records. The outbound surface from this file MUST NOT
//   call the GraphQL `deleteNote` mutation or any analogous
//   destructive mutation (deleteConversation, deleteConversationMembership,
//   deleteUser, etc.). Care Station's role is triage and reply, not
//   record management. The rule applies in spirit beyond literal
//   "delete" mutations: any update that would functionally invalidate
//   a record is equivalent and equally forbidden.
//
//   The safeHealthieFetch() wrapper below enforces this at the HTTP-
//   method level (refuses DELETE). The GraphQL operation-name guard
//   below adds a second layer: every GraphQL request goes through a
//   wrapper that refuses operations whose name starts with "delete".
//
//   Incoming `message.deleted` / `conversation_membership.deleted`
//   events from Healthie's webhooks are OBSERVATIONS of upstream UI
//   actions — we audit-log them and 200-ack. We do not act on them
//   to mirror destruction into our DB. Records persist on our side
//   regardless of what happens in Healthie's UI.
//
// Tenant identification (single-tenant trial):
//   Reads HEALTHIE_TENANT_COMPANY_ID env var. Same pattern as
//   intercom.js — when multi-tenant lands, the webhook URL would be
//   tenant-keyed and we'd resolve from the path.
//
// Audit log: every event past signature verification gets a row in
// inbound_raw_event regardless of outcome (processed, ignored
// because of unsupported event_type, ignored because no API key,
// ignored because the Note is provider-authored, etc.). Mirrors the
// intercom.js auditInbound pattern.

const crypto = require('crypto');
const { logError } = require('./_lib/log');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const HEALTHIE_WEBHOOK_SECRET = process.env.HEALTHIE_WEBHOOK_SECRET;
const HEALTHIE_TENANT_COMPANY_ID = process.env.HEALTHIE_TENANT_COMPANY_ID;
const HEALTHIE_API_KEY = process.env.HEALTHIE_API_KEY;
const HEALTHIE_GRAPHQL_URL =
  process.env.HEALTHIE_GRAPHQL_URL || 'https://api.gethealthie.com/graphql';

// Hold-window constant must match intercom.js — both adapters feed
// into the same query_history coalescing pipeline (mig 0033).
const HOLD_WINDOW_MS = 5 * 60 * 1000;

// Event types we ACT on (extract + insert). Everything else is
// audit-logged and 200-acked. Currently scoped to message.created;
// scheduled_message.sent could be added later if those should also
// generate tasks (semantics need vendor clarification first).
const HEALTHIE_SUPPORTED_EVENTS = new Set([
  'message.created',
]);

// Event types we explicitly recognize but ignore. Splitting from the
// generic "unsupported" bucket so audit-log readers can tell
// "Healthie sent us X, we knew about X, we deliberately skipped it"
// from "Healthie sent us X and we didn't know what X is."
const HEALTHIE_IGNORED_EVENTS = new Set([
  'message.deleted',                  // observation; we don't mirror destruction
  'scheduled_message.sent',           // not yet wired
  'conversation.created',             // we wait for the first message inside
  'conversation.updated',
  'conversation_membership.created',
  'conversation_membership.deleted',  // observation; we don't mirror destruction
  'conversation_membership.viewed',
]);

// Forbidden HTTP methods on outbound calls to Healthie's REST surface
// (GraphQL is POST-only anyway, but the wrapper is the runtime half
// of the no-DELETE policy in the header comment).
const HEALTHIE_FORBIDDEN_METHODS = new Set(['DELETE']);

// safeHealthieFetch — every outbound Healthie API call must route
// through this wrapper. Refuses DELETE at runtime; the policy comment
// covers destructive GraphQL mutations separately.
async function safeHealthieFetch(url, opts) {
  const options = opts || {};
  const method = (options.method || 'GET').toUpperCase();
  if (HEALTHIE_FORBIDDEN_METHODS.has(method)) {
    throw new Error(
      'Healthie no-DELETE policy: HTTP method ' + method + ' is not permitted '
      + 'from Care Station. See the policy header in netlify/functions/healthie.js.'
    );
  }
  return fetch(url, options);
}

// safeHealthieGraphQL — Healthie's API is GraphQL, so a method-only
// guard isn't enough; a `deleteNote` mutation rides on POST. Refuse
// any GraphQL operation whose name starts with "delete" (case-
// insensitive). Extracted to a pure helper so the rule is testable.
//
// Returns the operation name (mutation name) if the query is destructive,
// null otherwise. Callers wrap with a throw.
function detectDestructiveGraphQLOp(query) {
  if (typeof query !== 'string') return null;
  // Strip comments + whitespace; look for "mutation <Name>" or shorthand
  // "mutation { deleteFoo ... }". Conservative match.
  const match = query.match(/mutation\s+(\w+)|mutation\s*\{\s*(\w+)/);
  const name = match ? (match[1] || match[2] || '') : '';
  if (!name) return null;
  if (/^delete/i.test(name)) return name;
  return null;
}

// ── Signature verification ────────────────────────────────────────
//
// Healthie uses HTTP-Message-Signatures-style verification:
//   * Sender computes Content-Digest = sha-256 of the raw body.
//   * Sender constructs a canonical string:
//       method + ' ' + path + ' ' + query + ' ' + contentDigest
//       + ' ' + contentType + ' ' + contentLength
//   * Sender signs that string with HMAC-SHA256 using the shared
//     secret (whsec_*) and ships the result in the Signature header.
//
// We replicate the construction from our own request details, ignoring
// what the sender claims, and timing-safe-compare the result against
// the Signature header.
//
// Path note: Netlify may rewrite the URL via netlify.toml. If the
// configured webhook URL on Healthie's side is e.g. /webhooks/healthie
// but Netlify delivers it as /.netlify/functions/healthie, the paths
// won't match. The HEALTHIE_SIGNATURE_PATH env var (optional) lets
// ops override the path component used in the canonical string.

function computeContentDigest(rawBody) {
  // RFC-style "sha-256=:<base64>:". Healthie's example uses this
  // structured-fields format; if the actual production format differs,
  // adjust here.
  const hash = crypto.createHash('sha256').update(rawBody || '').digest('base64');
  return 'sha-256=:' + hash + ':';
}

function buildCanonicalString({ method, path, query, contentDigest, contentType, contentLength }) {
  return [
    (method || '').toUpperCase(),
    path || '',
    query || '',
    contentDigest || '',
    contentType || '',
    String(contentLength == null ? '' : contentLength),
  ].join(' ');
}

// Pull the raw signature value out of the Signature header. Healthie's
// docs show `Signature` carrying the HMAC; format may be plain hex,
// base64, or wrapped like `sig1=:<base64>:`. We handle the most likely
// shapes and return the raw bytes to compare.
function parseSignatureHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  // Structured-fields format: sig1=:<base64>:
  const sfMatch = trimmed.match(/^\w+=\:([^:]+)\:$/);
  if (sfMatch) {
    try { return Buffer.from(sfMatch[1], 'base64'); }
    catch (e) { return null; }
  }
  // Bare hex (checked before bare base64 because hex chars are a
  // strict subset of base64 chars — without this ordering, a string
  // like "deadbeef" matches the base64 regex and is decoded as base64,
  // producing the wrong bytes). Requires even length.
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    try { return Buffer.from(trimmed, 'hex'); }
    catch (e) { return null; }
  }
  // Bare base64 (must contain at least one non-hex char OR be otherwise
  // unambiguously base64 — but at this point hex has already been ruled
  // out by the regex above, so any remaining base64-shape input lands here).
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    try { return Buffer.from(trimmed, 'base64'); }
    catch (e) { return null; }
  }
  return null;
}

function verifyHealthieSignature({ method, path, query, rawBody, headers, secret }) {
  if (!secret) return false;
  if (!headers) return false;
  const sigHeader = headers['signature']
    || headers['Signature']
    || headers['x-signature']
    || '';
  const expected = parseSignatureHeader(sigHeader);
  if (!expected) return false;

  const contentType = headers['content-type'] || headers['Content-Type'] || 'application/json';
  const contentLength = headers['content-length'] || headers['Content-Length']
    || String(Buffer.byteLength(rawBody || '', 'utf8'));
  const contentDigest = computeContentDigest(rawBody);

  const canonical = buildCanonicalString({
    method, path, query, contentDigest, contentType, contentLength,
  });
  const computed = crypto.createHmac('sha256', secret).update(canonical).digest();

  if (expected.length !== computed.length) return false;
  try {
    return crypto.timingSafeEqual(expected, computed);
  } catch (e) {
    return false;
  }
}

// ── Webhook payload helpers ───────────────────────────────────────

function isSupportedEvent(eventType) {
  return HEALTHIE_SUPPORTED_EVENTS.has(eventType);
}

function isIgnoredEvent(eventType) {
  return HEALTHIE_IGNORED_EVENTS.has(eventType);
}

// Build the per-event external_id used for idempotency. Mirrors the
// intercom pattern (intercom:<conv>:<part>); for Healthie we use
// the resource type + id since webhooks don't carry a conversation
// id at the webhook level (only after the GraphQL fetch).
function buildExternalId(resourceType, resourceId) {
  if (!resourceType || !resourceId) return null;
  return 'healthie:' + resourceType + ':' + resourceId;
}

// ── GraphQL fetch ─────────────────────────────────────────────────
//
// Given a Note resource id (from the webhook), fetch the full note
// including content, creator, and conversation memberships. We use
// this to (a) extract the actual message body, (b) confirm the
// author is a patient (not a provider), and (c) discover the
// conversation_id for thread linking.
//
// Returns a normalized message object on success, or null on any
// failure (network, GraphQL error, malformed response, etc.). The
// caller treats null as "audit-log and 200-ack; nothing to insert."

const FETCH_NOTE_QUERY = `
  query CareStationFetchNote($id: ID!) {
    note(id: $id) {
      id
      content
      created_at
      creator {
        id
        full_name
        email
        dietitian
      }
      conversation {
        id
      }
    }
  }
`;

async function fetchHealthieNote(noteId) {
  if (!HEALTHIE_API_KEY) return null;
  if (!noteId) return null;

  // Destructive-op guard. The query above is read-only, but this is
  // belt-and-suspenders for the day someone adds a mutation here.
  const destructive = detectDestructiveGraphQLOp(FETCH_NOTE_QUERY);
  if (destructive) {
    throw new Error(
      'Healthie no-DELETE policy: GraphQL operation "' + destructive
      + '" rejected. See policy header in netlify/functions/healthie.js.'
    );
  }

  try {
    const r = await safeHealthieFetch(HEALTHIE_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + HEALTHIE_API_KEY,
        'Content-Type': 'application/json',
        'AuthorizationSource': 'API',
      },
      body: JSON.stringify({
        query: FETCH_NOTE_QUERY,
        variables: { id: String(noteId) },
      }),
    });
    if (!r.ok) {
      logError('healthie.graphql.http_error', null, {
        status: r.status,
        note_id: noteId,
      });
      return null;
    }
    const body = await r.json();
    if (body && body.errors) {
      logError('healthie.graphql.errors', null, {
        note_id: noteId,
        errors: JSON.stringify(body.errors).slice(0, 300),
      });
      return null;
    }
    const note = body && body.data && body.data.note;
    if (!note || !note.id) return null;
    return note;
  } catch (e) {
    logError('healthie.graphql.exception', e, { note_id: noteId });
    return null;
  }
}

// Convert a fetched Note into the shape we insert. Returns null if
// the note represents a provider-authored message (we only triage
// patient → practice messages, not the reverse) or if it lacks the
// content we need.
//
// TODO(healthie-schema): Confirm field shapes against Healthie's
// production GraphQL response. Especially:
//   * `creator.dietitian` — true for providers. If Healthie uses
//     a different role discriminator (e.g., `role` enum), update.
//   * `conversation.id` — assumes nested resolver returns it. Some
//     versions may require `conversation_id` as a sibling field.
function normalizeNoteForInsert(note) {
  if (!note || !note.id) return null;
  const creator = note.creator || {};
  const isProvider = creator.dietitian === true;
  if (isProvider) return null;  // provider-authored; not a triage event
  const content = (note.content || '').trim();
  if (!content) return null;
  const conversationId = note.conversation && note.conversation.id;
  return {
    noteId: String(note.id),
    conversationId: conversationId ? String(conversationId) : null,
    content,
    patientId: creator.id ? String(creator.id) : null,
    patientName: creator.full_name || null,
    patientEmail: creator.email || null,
  };
}

// ── Coalescing (shared with intercom.js semantics — mig 0033) ─────
//
// Duplicated here rather than imported because both adapters benefit
// from owning their own decision shape and the helper is tiny. If a
// third channel needs the same logic, lift to a shared module.
function buildCoalescingFields(existingOpenPrimaryId, nowMs) {
  if (existingOpenPrimaryId) {
    return { primary_task_id: existingOpenPrimaryId, surface_at: null };
  }
  return {
    primary_task_id: null,
    surface_at: new Date(nowMs + HOLD_WINDOW_MS).toISOString(),
  };
}

// ── Audit log ─────────────────────────────────────────────────────

async function auditInbound(h, fields) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/inbound_raw_event`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        company_id: fields.company_id || null,
        source_channel: 'healthie',
        topic: fields.topic || null,
        external_id: fields.external_id || null,
        raw_payload: fields.raw_payload || null,
        processed: !!fields.processed,
        processed_reason: fields.processed_reason || null,
        triage_id: fields.triage_id || null,
      }),
    });
  } catch (e) {
    logError('healthie.audit_inbound_failed', e);
  }
}

// ── Handler ───────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!SUPABASE_URL || !(SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }
  if (!HEALTHIE_WEBHOOK_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HEALTHIE_WEBHOOK_SECRET not configured' }) };
  }
  if (!HEALTHIE_TENANT_COMPANY_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HEALTHIE_TENANT_COMPANY_ID not configured' }) };
  }

  // Verify the signature against the raw body + canonical request
  // metadata. Netlify provides the raw body as a string; the
  // canonical string also needs method/path/query/contentType/length.
  const rawBody = event.body || '';
  const headers = event.headers || {};
  const method = event.httpMethod;
  const path = process.env.HEALTHIE_SIGNATURE_PATH || event.path || '';
  const query = event.rawQuery || '';

  const sigOk = verifyHealthieSignature({
    method, path, query, rawBody, headers,
    secret: HEALTHIE_WEBHOOK_SECRET,
  });
  if (!sigOk) {
    logError('healthie.signature_invalid', null, {
      path: path,
      sig_header_present: !!(headers['signature'] || headers['Signature']),
    });
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid webhook signature' }) };
  }

  // Parse the (now-trusted) payload.
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const eventType = payload && payload.event_type;
  const resourceId = payload && payload.resource_id;
  const resourceType = payload && payload.resource_id_type;
  const externalId = buildExternalId(resourceType, resourceId);

  const writeKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  const h = {
    'Content-Type': 'application/json',
    'apikey': writeKey,
    'Authorization': 'Bearer ' + writeKey,
    'Prefer': 'return=representation',
  };

  const auditBase = {
    company_id: HEALTHIE_TENANT_COMPANY_ID,
    topic: eventType,
    raw_payload: payload,
    external_id: externalId,
  };

  // Known-but-ignored events: 200-ack with a processed_reason so the
  // audit row tells us we deliberately skipped.
  if (isIgnoredEvent(eventType)) {
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'ignored_event_type' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, event_type: eventType }),
    };
  }
  // Unknown events: same response shape but processed_reason
  // distinguishes them. If a new event type lands and we want to
  // handle it, the audit log is where we discover it.
  if (!isSupportedEvent(eventType)) {
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'unsupported_event_type' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, event_type: eventType || null }),
    };
  }

  // API-key gate. Without it, we cannot fetch the actual Note content
  // — log the gap, audit-only, 200-ack. This is the deliberate "we
  // need the API key" state described in the file header.
  if (!HEALTHIE_API_KEY) {
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'no_api_key' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ignored: true,
        reason: 'HEALTHIE_API_KEY not set — webhook audited but no message extracted.',
      }),
    };
  }

  // Idempotency. Race against the unique partial index on
  // (company_id, external_id) as the backstop if this check loses to
  // a duplicate delivery.
  try {
    const dupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history`
        + `?company_id=eq.${encodeURIComponent(HEALTHIE_TENANT_COMPANY_ID)}`
        + `&external_id=eq.${encodeURIComponent(externalId)}`
        + `&select=id,status&limit=1`,
      { headers: h }
    );
    const dupes = await dupRes.json();
    if (Array.isArray(dupes) && dupes[0]) {
      await auditInbound(h, {
        ...auditBase, processed: false, processed_reason: 'duplicate', triage_id: dupes[0].id,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, duplicate: true, task_id: dupes[0].id }),
      };
    }
  } catch (e) {
    logError('healthie.dupCheck', e);
    // Continue; unique index is the backstop.
  }

  // Fetch the actual Note content via GraphQL.
  const note = await fetchHealthieNote(resourceId);
  if (!note) {
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'graphql_fetch_failed' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true, reason: 'Note fetch failed' }),
    };
  }

  const normalized = normalizeNoteForInsert(note);
  if (!normalized) {
    await auditInbound(h, {
      ...auditBase,
      processed: false,
      processed_reason: 'normalize_skipped',
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ignored: true,
        reason: 'Note is provider-authored or has no content.',
      }),
    };
  }

  // Coalescing lookup (mig 0033) — same pattern as intercom.js.
  let existingOpenPrimaryId = null;
  if (normalized.conversationId) {
    try {
      const lookupUrl = `${SUPABASE_URL}/rest/v1/query_history`
        + `?company_id=eq.${encodeURIComponent(HEALTHIE_TENANT_COMPANY_ID)}`
        + `&conversation_id=eq.${encodeURIComponent(normalized.conversationId)}`
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
      }
    } catch (e) {
      logError('healthie.coalesce_lookup', e, { conversation_id: normalized.conversationId });
    }
  }
  const coalescing = buildCoalescingFields(existingOpenPrimaryId, Date.now());

  const record = {
    company_id: HEALTHIE_TENANT_COMPANY_ID,
    patient_message: normalized.content,
    source_channel: 'healthie',
    external_id: externalId,
    conversation_id: normalized.conversationId,
    patient_email: normalized.patientEmail,
    patient_name: normalized.patientName,
    healthie_patient_id: normalized.patientId,
    status: 'pending',
    urgency_original: 'routine',
    non_clinical_flag: false,
    non_clinical_items: [],
    follow_up_questions: [],
    draft_response: '',
    fin_participated: false,  // not applicable to Healthie
    primary_task_id: coalescing.primary_task_id,
    surface_at: coalescing.surface_at,
  };

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/query_history`, {
      method: 'POST', headers: h,
      body: JSON.stringify(record),
    });
    const result = await insertRes.json();

    if (!insertRes.ok || !Array.isArray(result) || !result[0]) {
      logError('healthie.insertFailed', null, {
        status: insertRes.status,
        body: JSON.stringify(result).slice(0, 300),
      });
      await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'insert_failed' });
      return {
        statusCode: insertRes.ok ? 502 : insertRes.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: 'Failed to queue task. Webhook retry is safe — external_id dedupes.',
        }),
      };
    }

    await auditInbound(h, {
      ...auditBase,
      processed: true,
      processed_reason: 'inserted',
      triage_id: result[0].id,
    });

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        task_id: result[0].id,
        status: 'pending',
        healthie_conversation_id: normalized.conversationId,
      }),
    };
  } catch (e) {
    logError('healthie.insert', e);
    await auditInbound(h, { ...auditBase, processed: false, processed_reason: 'insert_exception' });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Insert failed' }),
    };
  }
};

// Re-export pure helpers for tests.
exports.computeContentDigest = computeContentDigest;
exports.buildCanonicalString = buildCanonicalString;
exports.parseSignatureHeader = parseSignatureHeader;
exports.verifyHealthieSignature = verifyHealthieSignature;
exports.isSupportedEvent = isSupportedEvent;
exports.isIgnoredEvent = isIgnoredEvent;
exports.buildExternalId = buildExternalId;
exports.buildCoalescingFields = buildCoalescingFields;
exports.normalizeNoteForInsert = normalizeNoteForInsert;
exports.detectDestructiveGraphQLOp = detectDestructiveGraphQLOp;
exports.safeHealthieFetch = safeHealthieFetch;
exports.HEALTHIE_SUPPORTED_EVENTS = HEALTHIE_SUPPORTED_EVENTS;
exports.HEALTHIE_IGNORED_EVENTS = HEALTHIE_IGNORED_EVENTS;
exports.HEALTHIE_FORBIDDEN_METHODS = HEALTHIE_FORBIDDEN_METHODS;
exports.HOLD_WINDOW_MS = HOLD_WINDOW_MS;
