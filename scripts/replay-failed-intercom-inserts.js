#!/usr/bin/env node
// scripts/replay-failed-intercom-inserts.js
//
// CLINICAL-SENSITIVE — writes new query_history rows the worker will
// classify and route. Read this whole comment before running.
//
// Recovers patient messages that arrived during the 2026-05-17 →
// 2026-05-18 outage. Between commits 344d71a (11:03 AM) and the
// migration backlog being applied, every intercom.js insert into
// query_history hit a PGRST204 ("column does not exist") because
// migrations 0028, 0029, 0033, 0034, 0035 had not been applied. The
// webhook handler captured every failed payload to inbound_raw_event
// (mig 0024) with processed=false, processed_reason='insert_failed',
// raw_payload=<full Intercom payload>. This script re-runs those
// payloads through the same extraction the live handler uses and
// inserts them into query_history.
//
// Why this is safe to re-run:
//   * Inserts use Prefer: resolution=ignore-duplicates against the
//     (company_id, external_id) unique partial index from migration
//     0001. A second run sees the row already exists and skips it.
//   * The audit row update is conditional on the audit id; idempotent.
//   * No Intercom API calls — we replay captured payloads only. Bask
//     order/master id enrichment is handled separately by the existing
//     scripts/backfill-bask-master-id.js script if needed afterwards.
//
// Why chronological order matters:
//   The coalescing lookup (intercom.js buildCoalescingFields) decides
//   primary-vs-follow-on based on whether an open primary already
//   exists in query_history for the conversation. Replaying oldest
//   first reproduces the primary/follow-on layout the live handler
//   would have produced.
//
// Why we preserve the audit row's created_at on the new query_history
// row:
//   Without this, every replayed row would sort to "now" in the queue.
//   With it, queue priority and SLA timers match what staff would have
//   seen if the outage hadn't happened.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY            (service role; bypasses RLS)
//   INTERCOM_TENANT_COMPANY_ID      (matches the live intercom.js)
//
// Optional:
//   SINCE='2026-05-17T17:47:00Z'    (UTC; defaults to 10:47 AM Pacific)
//   DRY_RUN=1                       (print what would happen, write nothing)
//   LIMIT=<n>                       (process at most N audit rows)
//
// Run:
//   node scripts/replay-failed-intercom-inserts.js
//
// After running, the worker (every 4 hours, or manual "Fetch & triage")
// will classify the new pending rows.

const {
  extractMessage,
  stripHtml,
  isSystemPlaceholder,
  isAiAgentParticipated,
  buildCoalescingFields,
} = require('../netlify/functions/intercom.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INTERCOM_TENANT_COMPANY_ID = process.env.INTERCOM_TENANT_COMPANY_ID;
const SINCE = process.env.SINCE || '2026-05-17T17:47:00Z';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;

function bail(msg) {
  console.error('error:', msg);
  process.exit(1);
}

if (!SUPABASE_URL) bail('SUPABASE_URL not set');
if (!SUPABASE_SERVICE_KEY) bail('SUPABASE_SERVICE_KEY not set');
if (!INTERCOM_TENANT_COMPANY_ID) bail('INTERCOM_TENANT_COMPANY_ID not set');

const dbHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
};

// Mark replayed audit rows + new query_history rows so we can trace
// them back to the outage. Visible in the SPA's Event Log and on the
// row's internal_note.
const BREADCRUMB = 'REPLAYED from 2026-05-17/2026-05-18 outage (mig 0028-0035 drift)';
const REPLAYED_REASON = 'replayed_inserted';

async function fetchPendingReplays() {
  const limitClause = LIMIT ? `&limit=${LIMIT}` : '';
  const url = SUPABASE_URL + '/rest/v1/inbound_raw_event'
    + '?source_channel=eq.intercom'
    + '&processed=eq.false'
    + '&processed_reason=eq.insert_failed'
    + '&created_at=gte.' + encodeURIComponent(SINCE)
    + '&select=id,raw_payload,external_id,created_at'
    + '&order=created_at.asc'
    + limitClause;
  const r = await fetch(url, { headers: dbHeaders });
  if (!r.ok) throw new Error('audit read failed: ' + r.status + ' ' + await r.text());
  return r.json();
}

// Coalescing lookup mirrors intercom.js:823-829. The status values
// are safe identifiers (no special chars) so they don't need the
// quote-and-escape treatment the live handler does — unquoted form
// dodges any URL-encoding ambiguity around the inline `"` characters.
// If an open primary already exists for the conversation, this row
// attaches as a follow-on; otherwise this row IS the primary.
async function findOpenPrimaryId(conversationId) {
  const url = SUPABASE_URL + '/rest/v1/query_history'
    + '?company_id=eq.' + encodeURIComponent(INTERCOM_TENANT_COMPANY_ID)
    + '&conversation_id=eq.' + encodeURIComponent(conversationId)
    + '&primary_task_id=is.null'
    + '&status=in.(pending,triaged,reviewed,patient_replied)'
    + '&select=id'
    + '&order=created_at.asc&limit=1';
  const r = await fetch(url, { headers: dbHeaders });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.warn('  primary-lookup failed (' + r.status + '): ' + body.slice(0, 200));
    return null;
  }
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].id : null;
}

async function insertWithIgnoreDuplicates(record) {
  if (DRY_RUN) return { ok: true, dryRun: true, row: null };
  const r = await fetch(SUPABASE_URL + '/rest/v1/query_history', {
    method: 'POST',
    headers: {
      ...dbHeaders,
      // ignore-duplicates: on (company_id, external_id) conflict, do
      // nothing and return an empty array. return=representation: get
      // the inserted row back on success.
      'Prefer': 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(record),
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => '');
    // PostgREST returns JSON like { code, details, hint, message }.
    // We want `message` (which names the offending column) more than
    // we want `details` (which dumps the whole row). Print both, but
    // surface `message` first so it's not buried.
    let msg = '';
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.message) msg = ' message=' + parsed.message;
    } catch (e) { /* keep raw */ }
    return { ok: false, status: r.status, body: msg + ' raw=' + raw.slice(0, 1500) };
  }
  const rows = await r.json();
  const row = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
  return { ok: true, row, skippedDuplicate: !row };
}

async function markAuditReplayed(auditId, triageId) {
  if (DRY_RUN) return true;
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/inbound_raw_event?id=eq.' + encodeURIComponent(auditId),
    {
      method: 'PATCH',
      headers: { ...dbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        processed: true,
        processed_reason: REPLAYED_REASON,
        triage_id: triageId,
      }),
    }
  );
  if (!r.ok) {
    console.warn('  audit-update failed for ' + auditId + ': ' + r.status + ' ' + await r.text());
    return false;
  }
  return true;
}

// Defensive: re-run extraction so we filter the same way the live
// handler does. Returns either { record, externalId } or { skip, reason }.
function buildRecordFromAudit(audit) {
  const payload = audit.raw_payload;
  if (!payload) return { skip: true, reason: 'no_raw_payload' };

  const topic = payload.topic;
  const SUPPORTED = ['conversation.user.created', 'conversation.user.replied'];
  if (!SUPPORTED.includes(topic)) {
    return { skip: true, reason: 'unsupported_topic' };
  }

  const msg = extractMessage(payload);
  if (!msg) return { skip: true, reason: 'no_user_message' };

  const externalId = 'intercom:' + msg.conversationId + ':' + msg.partId;
  const text = stripHtml(msg.messageHtml);
  if (!text) return { skip: true, reason: 'empty_after_strip' };
  if (isSystemPlaceholder(text)) return { skip: true, reason: 'system_placeholder' };

  return { msg, externalId, text, finFlag: isAiAgentParticipated(payload) };
}

async function main() {
  console.log('replay-failed-intercom-inserts starting' + (DRY_RUN ? ' (DRY_RUN)' : ''));
  console.log('since:', SINCE);

  const audits = await fetchPendingReplays();
  console.log('audit rows to replay:', audits.length);
  if (audits.length === 0) {
    console.log('nothing to do');
    return;
  }

  const counts = {
    inserted: 0,
    skipped_duplicate: 0,
    skipped_filtered: 0,
    insert_errors: 0,
  };

  for (const audit of audits) {
    const built = buildRecordFromAudit(audit);
    if (built.skip) {
      console.log('  ' + audit.id + ' skip:', built.reason);
      counts.skipped_filtered++;
      continue;
    }

    const { msg, externalId, text, finFlag } = built;

    // Coalescing decision against current DB state, mirroring the
    // live handler. Replaying oldest first means a conversation's
    // first replayed row becomes the primary; subsequent rows on the
    // same conversation see that primary and attach as follow-ons.
    const existingOpenPrimaryId = await findOpenPrimaryId(msg.conversationId);
    // Use the audit row's original arrival time as "now" for the
    // hold-window math, so the surface_at lands where it would have
    // in real time. Date.parse returns NaN on bad input — fall back
    // to current time defensively.
    const auditTimeMs = Date.parse(audit.created_at);
    const nowForCoalescing = Number.isFinite(auditTimeMs) ? auditTimeMs : Date.now();
    const coalescing = buildCoalescingFields(existingOpenPrimaryId, nowForCoalescing);

    const record = {
      company_id: INTERCOM_TENANT_COMPANY_ID,
      patient_message: text,
      source_channel: 'intercom',
      external_id: externalId,
      conversation_id: msg.conversationId,
      patient_email: msg.authorEmail || null,
      patient_name: msg.authorName || null,
      // nurse_name: legacy column the prod DB still has a NOT NULL
      // constraint on (added manually in the Supabase dashboard, not
      // tracked in the repo's migrations). The current intercom.js
      // doesn't write this since commit 1f0928a — patient identity
      // lives in patient_name / patient_email now. We set it here so
      // the replay succeeds even before migration 0037 (which drops
      // the NOT NULL) lands. After 0037, this value is a harmless
      // duplicate of patient_name on these specific replayed rows.
      nurse_name: msg.authorName || 'Intercom',
      status: 'pending',
      urgency_original: 'routine',
      non_clinical_flag: false,
      non_clinical_items: [],
      follow_up_questions: [],
      draft_response: '',
      fin_participated: finFlag,
      primary_task_id: coalescing.primary_task_id,
      surface_at: coalescing.surface_at,
      bask_patient_id: msg.baskPatientId || null,
      intercom_contact_id: msg.intercomContactId || null,
      // Preserve original arrival time so queue priority + SLA timers
      // match what staff would have seen in real time. Postgres will
      // accept an ISO 8601 string for timestamptz columns.
      created_at: audit.created_at,
      internal_note: BREADCRUMB,
    };

    const result = await insertWithIgnoreDuplicates(record);
    if (!result.ok) {
      console.warn('  ' + audit.id + ' insert FAILED:', result.status, result.body);
      counts.insert_errors++;
      continue;
    }
    if (result.skippedDuplicate) {
      console.log('  ' + audit.id + ' skip: already exists in query_history (external_id=' + externalId + ')');
      counts.skipped_duplicate++;
      // Still mark the audit row as replayed-or-deduped so the next
      // run doesn't pick it up. Look up the existing row's id first.
      const dupRow = await findQueryHistoryByExternalId(externalId);
      if (dupRow) await markAuditReplayed(audit.id, dupRow.id);
      continue;
    }
    if (result.dryRun) {
      console.log('  ' + audit.id + ' would insert:', externalId, 'coalesce=' + (coalescing.primary_task_id ? 'follow-on' : 'primary'));
      continue;
    }
    counts.inserted++;
    console.log('  ' + audit.id + ' inserted ' + result.row.id + ' (' + externalId + ', ' + (coalescing.primary_task_id ? 'follow-on' : 'primary') + ')');
    await markAuditReplayed(audit.id, result.row.id);
  }

  console.log('done:', counts);
  if (!DRY_RUN && counts.inserted > 0) {
    console.log('next: run the worker (or wait for the 4-hour cron) to classify the new pending rows');
  }
}

async function findQueryHistoryByExternalId(externalId) {
  const url = SUPABASE_URL + '/rest/v1/query_history'
    + '?company_id=eq.' + encodeURIComponent(INTERCOM_TENANT_COMPANY_ID)
    + '&external_id=eq.' + encodeURIComponent(externalId)
    + '&select=id,status&limit=1';
  const r = await fetch(url, { headers: dbHeaders });
  if (!r.ok) return null;
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0] : null;
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
