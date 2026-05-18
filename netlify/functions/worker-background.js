// netlify/functions/worker.js
//
// Background processor for query_history rows in status='pending'.
// Pulls a batch oldest-first, runs each through the triage pipeline
// (via _lib/triage-core.runTriage), writes the classification +
// telemetry back, and transitions status. Pre-PR-2 this was a stub
// that drained the queue with a placeholder draft; now it makes a
// real Claude call for each row and applies the multi-layer safety
// pipeline through the shared helper.
//
// Per-row flow:
//
//   1. Fin defense — if fin_participated === true, skip the Claude
//      call entirely and PATCH status='reviewed' + an explanatory
//      internal_note. Defense in depth against Intercom's AI Agent
//      (Fin); see migration 0023 and netlify/functions/intercom.js
//      for the upstream detection.
//
//   2. Normal triage — call runTriage with the row's company_id and
//      patient_message. On success, map the normalized output and
//      _relai telemetry to query_history columns and PATCH:
//        - status: 'triaged' OR 'reviewed' if the safety pipeline
//          set route_to_human_review (parse failed, validation
//          failed, tripwire matched, or Haiku verdict != 'agree').
//        - classification fields (clinical_category, urgency_*,
//          clinical_routing_level, routed_to, draft_response,
//          internal_note, ai_confidence, non_clinical_*).
//        - telemetry (model, latency_ms, cost_usd, token counts).
//
//   3. Failure — runTriage returned { ok: false }. Leave the row at
//      status='pending' (no PATCH) and write a failure audit entry.
//      Next worker run will retry. Risk acknowledged: a permanently
//      bad row could loop forever; add an attempt counter / DLQ
//      behavior if it shows up in practice.
//
// Invocation: the worker is not scheduled yet. Per ROADMAP Week 4
// it'll be activated via Netlify scheduled functions, Supabase
// pg_cron, or an external trigger. Today the function exists and
// can be hit manually (HTTP) to drain the queue, which is enough
// for beta development + manual ops.
//
// Concurrency: no explicit row lock. The atomic-claim pattern (PATCH
// with a `status=eq.pending` filter that flips status as it writes)
// keeps the race window narrow. If two workers race on the same row,
// the second sees no rows updated and skips. For higher concurrency
// later, add Postgres advisory locks via a Supabase RPC.

const { runTriage } = require("./_lib/triage-core");
const { computeUrgencyScore } = require("../../data/triage-lib");
const { RELAI_DEFAULTS } = require("../../data/defaults");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const WORKER_BATCH_SIZE = 5;
// Sonnet 4.6 per PLAN.md decision log (2026-05-08): safety-critical
// classification needs Sonnet; Haiku is reserved for correction-
// analysis and the optional second-pass safety check. The prior
// 'claude-haiku-4-5' value here was a regression caught in the
// 2026-05-17 smoke test.
const WORKER_MODEL = 'claude-sonnet-4-6';
const WORKER_MAX_TOKENS = 1024;

// Note written onto a row when Fin participated in the upstream
// Intercom conversation. The staff member sees this in the queue
// and knows why the AI didn't produce a draft.
const FIN_SKIP_NOTE =
  'Fin (Intercom AI Agent) participated in this conversation. Routed to human review per Care Station policy — no automated triage performed.';

function writeHeaders() {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  return {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': 'Bearer ' + key,
  };
}

async function audit(entry, h) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error('worker.audit:', e.message);
  }
}

// ── Pure helpers (exported for tests) ──────────────────────────────

// Build the PATCH payload for a row that finished triage successfully.
// `normalized` is the canonical-enums triage output from
// data/triage-lib.normalizeTriageOutput; `relai` is the telemetry
// envelope from triage-core (model, latency, cost, usage, and
// optional route_to_human_review + route_reason from the safety
// pipeline). Defensive about missing fields — anything not present
// on the AI output falls back to null or the column's DB-default-
// compatible value so the PATCH never violates a NOT NULL.
//
// CHECK constraints honored:
//   - urgency_original ∈ {routine, same-day, urgent, NULL}
//   - clinical_routing_level ∈ {severe, moderate, mild, none, NULL}  (defaults 'none')
//   - clinical_category ∈ canonical 6 or NULL  (normalize already canonicalized)
//   - ai_confidence ∈ [0, 1] or NULL
function buildTriagePatch(normalized, relai) {
  const n = normalized || {};
  const r = relai || {};
  const usage = r.usage || {};

  const status = r.route_to_human_review ? 'reviewed' : 'triaged';

  // ai_confidence: only persist real numbers in [0, 1]; anything
  // else → null (the DB CHECK rejects out-of-range values).
  // normalizeTriageOutput lifts review_request.confidence here.
  let conf = null;
  if (typeof n.ai_confidence === 'number' && n.ai_confidence >= 0 && n.ai_confidence <= 1) {
    conf = n.ai_confidence;
  }

  // ── Routing Hub override (Phase 3 protocol) ──────────────────────
  // When triage succeeded with a valid output but the AI flagged
  // its own confidence as low (< reviewConfidenceThreshold from
  // RELAI_DEFAULTS), the task lands in the Routing Hub pool for
  // non-clinical staff to recategorize. Status stays 'triaged' —
  // the row is valid output, just uncertain about category. The
  // AI's guessed category is preserved in internal_note as a
  // breadcrumb for the routing-hub worker.
  //
  // Does NOT fire on 'reviewed' rows — those are already escalated
  // by the safety pipeline (parse failed, validation failed,
  // tripwire, Haiku disagreement) and the safety state takes
  // precedence over confidence routing.
  let clinical_category = n.clinical_category || null;
  let internal_note = n.internal_note || null;

  const threshold = RELAI_DEFAULTS.reviewConfidenceThreshold;
  const routingHubCategory = RELAI_DEFAULTS.routingHubCategory;
  const isRoutingHubCase =
    status === 'triaged'
    && conf !== null
    && typeof threshold === 'number'
    && conf < threshold
    && !!routingHubCategory;

  if (isRoutingHubCase) {
    const original = clinical_category || '(uncategorized)';
    clinical_category = routingHubCategory;
    const note = '[Auto-routed to Routing Hub: AI confidence '
      + conf.toFixed(2) + ' below threshold ' + threshold
      + '. AI guessed category: "' + original + '". '
      + 'Please review and reassign to the correct category.]';
    internal_note = internal_note ? internal_note + '\n\n' + note : note;
  }

  // ── Reviewed-row breadcrumb ─────────────────────────────────────
  // When the safety pipeline forced 'reviewed' status, the AI's
  // output is often empty (parse_failed) or escalated (tripwire,
  // validation_failed). A staffer opening the row has no immediate
  // breadcrumb of why. Populate internal_note with the route_reason
  // so the reviewer has a starting point. The full detail still
  // lives in audit_log.
  if (status === 'reviewed' && r.route_reason && !internal_note) {
    internal_note = '[Auto-routed to human review: ' + r.route_reason
      + '. See audit_log triage.complete event for details.]';
  }

  return {
    status: status,
    clinical_category: clinical_category,
    urgency_original: n.urgency || null,
    urgency_score: computeUrgencyScore(n),
    clinical_routing_level: n.clinical_routing_level || 'none',
    routed_to: n.routed_to || null,
    non_clinical_flag: !!n.non_clinical_flag,
    non_clinical_items: Array.isArray(n.non_clinical_items) ? n.non_clinical_items : [],
    follow_up_questions: Array.isArray(n.follow_up_questions) ? n.follow_up_questions : [],
    draft_response: n.draft_response || '',
    internal_note: internal_note,
    ai_confidence: conf,
    // Telemetry envelope. Anthropic field names differ from our column
    // names — cache_{creation,read}_input_tokens → cache_*_tokens.
    model: r.model || null,
    latency_ms: r.latency_ms != null ? r.latency_ms : null,
    cost_usd: r.cost_usd != null ? r.cost_usd : null,
    input_tokens: usage.input_tokens != null ? usage.input_tokens : null,
    output_tokens: usage.output_tokens != null ? usage.output_tokens : null,
    cache_creation_tokens: usage.cache_creation_input_tokens != null ? usage.cache_creation_input_tokens : null,
    cache_read_tokens: usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : null,
  };
}

// Build the PATCH payload for a Fin-touched row. Status to reviewed,
// explanatory internal_note. No Claude call was made, so no
// classification fields and no telemetry.
function buildFinSkipPatch() {
  return {
    status: 'reviewed',
    internal_note: FIN_SKIP_NOTE,
  };
}

// ── Hold-window helpers (migration 0033) ──────────────────────────
//
// A primary task may carry `surface_at` set to "now + 5 minutes" at
// insert time. The queue read-time filter hides the row until
// surface_at passes. If the row's own classification (or the
// classification of a follow-on attached to it) clears the severity
// threshold, the hold is bypassed by clearing surface_at.

// Whether a classification patch represents a severity that should
// bypass the hold window. Today's rule: urgency_score at or above
// RELAI_DEFAULTS.severityUrgencyThreshold (matches the queue priority
// sort's definition of "severe" — see queue.js makeTaskPriorityCmp).
function clearsSeverityThreshold(patch, severityThreshold) {
  if (!patch) return false;
  const score = typeof patch.urgency_score === 'number' ? patch.urgency_score : 0;
  return score >= severityThreshold;
}

// Compute what (if anything) to PATCH onto a primary task when one of
// its follow-on rows finishes classification.
//
// Highest-severity-wins: a later mild follow-on never downgrades a
// primary's existing severity. We only write fields that strictly
// improve the primary's queue treatment:
//
//   * urgency_score:           write only if new > current
//   * urgency_original:        write alongside score climb
//   * clinical_routing_level:  write alongside score climb
//   * status:                  triaged → reviewed only (never reverse)
//   * surface_at:              cleared if the new row crosses the
//                              severity threshold AND the primary is
//                              still in its hold window
//
// Returns null when no upgrade applies. Race note: this is a
// read-modify-write so concurrent escalations from sibling follow-ons
// can interleave. The window is tiny in practice and the worst case
// is a single missed propagation — acceptable for v1. If we see it,
// upgrade to guarded PATCHes (urgency_score=lt.<new_score>) or move
// to an RPC.
function buildPrimaryEscalationPatch(currentPrimary, newClassification, severityThreshold) {
  if (!currentPrimary || !newClassification) return null;
  const patch = {};

  const newScore = typeof newClassification.urgency_score === 'number'
    ? newClassification.urgency_score : 0;
  const curScore = typeof currentPrimary.urgency_score === 'number'
    ? currentPrimary.urgency_score : 0;

  if (newScore > curScore) {
    patch.urgency_score = newScore;
    if (newClassification.urgency_original) {
      patch.urgency_original = newClassification.urgency_original;
    }
    if (newClassification.clinical_routing_level) {
      patch.clinical_routing_level = newClassification.clinical_routing_level;
    }
  }

  if (newClassification.status === 'reviewed' && currentPrimary.status !== 'reviewed') {
    patch.status = 'reviewed';
  }

  if (currentPrimary.surface_at && newScore >= severityThreshold) {
    patch.surface_at = null;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// ── Per-row processing ─────────────────────────────────────────────

async function patchRow(rowId, patch, h) {
  // Atomic transition: only PATCH rows still at status='pending'. If
  // two worker invocations race on the same row, the second one's
  // PATCH returns zero rows updated and we skip it.
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(rowId)}`
    + `&status=eq.pending`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('PATCH failed (' + r.status + '): ' + body.slice(0, 200));
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// Propagate severity from a freshly-classified follow-on row to its
// primary task. Read the primary's current queue-relevant fields,
// compute the patch via buildPrimaryEscalationPatch (highest-wins,
// never downgrades), and PATCH if any field would change. A null
// patch (or a missing primary) is a no-op.
async function propagateToPrimary(primaryId, followOnPatch, h) {
  const readUrl = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(primaryId)}`
    + `&select=urgency_score,urgency_original,clinical_routing_level,status,surface_at`
    + `&limit=1`;
  const readRes = await fetch(readUrl, { headers: h });
  if (!readRes.ok) {
    throw new Error('primary read failed (' + readRes.status + ')');
  }
  const rows = await readRes.json();
  const primary = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!primary) return;  // primary was deleted; nothing to do.

  const escalation = buildPrimaryEscalationPatch(
    primary, followOnPatch, RELAI_DEFAULTS.severityUrgencyThreshold
  );
  if (!escalation) return;

  const patchUrl = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(primaryId)}`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify(escalation),
  });
  if (!patchRes.ok) {
    const body = await patchRes.text().catch(() => '');
    throw new Error('primary PATCH failed (' + patchRes.status + '): ' + body.slice(0, 200));
  }
}

async function processRow(row, h, apiKey) {
  // Defense in depth: if Fin participated upstream, skip the Claude
  // call entirely and surface the row for human review.
  if (row.fin_participated === true) {
    const patch = buildFinSkipPatch();
    try {
      const updated = await patchRow(row.id, patch, h);
      if (updated.length === 0) {
        // Lost the race — another worker already transitioned this row.
        return { id: row.id, action: 'fin_skip_raced' };
      }
    } catch (e) {
      console.error('worker.fin_skip_patch:', e.message);
      await audit({
        company_id: row.company_id,
        actor_name: 'worker',
        event_type: 'triage.fin_skip_failed',
        entity_type: 'query_history',
        entity_id: row.id,
        payload: { error: e.message.slice(0, 200) },
      }, h);
      return { id: row.id, action: 'fin_skip_error', error: e.message };
    }
    await audit({
      company_id: row.company_id,
      actor_name: 'worker',
      event_type: 'triage.fin_skip',
      entity_type: 'query_history',
      entity_id: row.id,
      payload: { external_id: row.external_id || null },
    }, h);
    return { id: row.id, action: 'fin_skip' };
  }

  // Normal path: call the triage helper.
  const result = await runTriage({
    companyId: row.company_id,
    patientMessage: row.patient_message,
    model: WORKER_MODEL,
    maxTokens: WORKER_MAX_TOKENS,
    apiKey: apiKey,
  });

  if (!result.ok) {
    // Leave at status='pending' for retry on the next worker run.
    // No PATCH to status; audit the failure for visibility.
    await audit({
      company_id: row.company_id,
      actor_name: 'worker',
      event_type: 'triage.failed',
      entity_type: 'query_history',
      entity_id: row.id,
      payload: {
        external_id: row.external_id || null,
        status_code: result.statusCode || null,
        error: (result.error || '').slice(0, 200),
      },
    }, h);
    return { id: row.id, action: 'failed', error: result.error };
  }

  const relai = (result.parsed && result.parsed._relai) || {};
  const patch = buildTriagePatch(result.normalized || {}, relai);

  // Hold-window bypass (migration 0033). If this row is a primary that
  // was inserted with a surface_at hold and its own classification
  // clears the severity threshold, drop the hold so the queue surfaces
  // it immediately. Follow-on rows (primary_task_id IS NOT NULL)
  // shouldn't have surface_at set, but the guard is defensive.
  if (
    row.surface_at
    && !row.primary_task_id
    && clearsSeverityThreshold(patch, RELAI_DEFAULTS.severityUrgencyThreshold)
  ) {
    patch.surface_at = null;
  }

  try {
    const updated = await patchRow(row.id, patch, h);
    if (updated.length === 0) {
      return { id: row.id, action: 'triage_raced' };
    }
  } catch (e) {
    console.error('worker.triage_patch:', e.message);
    // We have a successful Anthropic call but the DB write failed.
    // This is a real inconsistency — log it loudly so we can chase
    // it later. The row stays at pending so the next worker run
    // will re-run the (expensive) Claude call. Acceptable for beta
    // since this should be rare.
    await audit({
      company_id: row.company_id,
      actor_name: 'worker',
      event_type: 'triage.patch_failed',
      entity_type: 'query_history',
      entity_id: row.id,
      payload: {
        error: e.message.slice(0, 200),
        // Don't echo the full draft into the audit log — risk of
        // dumping PHI-adjacent content into a non-encrypted store.
        cost_usd: relai.cost_usd || null,
      },
    }, h);
    return { id: row.id, action: 'patch_error', error: e.message };
  }

  // Propagate severity to the primary (migration 0033). When this row
  // is a follow-on, read the primary's current state and decide whether
  // its classification should be raised based on this row's result.
  // Highest-severity-wins; failures here are logged but never block the
  // worker — the follow-on's own classification is already persisted.
  if (row.primary_task_id) {
    try {
      await propagateToPrimary(row.primary_task_id, patch, h);
    } catch (e) {
      console.error('worker.propagate_to_primary:', e.message);
      await audit({
        company_id: row.company_id,
        actor_name: 'worker',
        event_type: 'triage.propagate_failed',
        entity_type: 'query_history',
        entity_id: row.primary_task_id,
        payload: {
          follow_on_id: row.id,
          error: e.message.slice(0, 200),
        },
      }, h);
    }
  }

  await audit({
    company_id: row.company_id,
    actor_name: 'worker',
    event_type: 'triage.complete',
    entity_type: 'query_history',
    entity_id: row.id,
    payload: {
      external_id: row.external_id || null,
      status: patch.status,
      route_reason: relai.route_reason || null,
      cost_usd: relai.cost_usd || null,
      latency_ms: relai.latency_ms || null,
    },
  }, h);
  return { id: row.id, action: 'triaged', status: patch.status };
}

// ── Handler ────────────────────────────────────────────────────────

exports.handler = async function () {
  if (!SUPABASE_URL || !(SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)) {
    return { statusCode: 500, body: 'Supabase not configured' };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: 'ANTHROPIC_API_KEY not configured' };
  }

  const h = writeHeaders();

  // Pick up pending rows oldest-first. The query_history.fin_participated
  // column is selected explicitly so the per-row branch can read it
  // without a second fetch.
  let pending;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history`
        + `?status=eq.pending`
        + `&order=created_at.asc&limit=${WORKER_BATCH_SIZE}`
        + `&select=id,company_id,external_id,patient_message,fin_participated,primary_task_id,surface_at`,
      { headers: h }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('worker.fetchPending:', r.status, body.slice(0, 200));
      return { statusCode: 500, body: 'fetch pending failed' };
    }
    pending = await r.json();
  } catch (e) {
    console.error('worker.fetchPending:', e.message);
    return { statusCode: 500, body: e.message };
  }

  if (!Array.isArray(pending) || pending.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ processed: 0, message: 'queue empty' }) };
  }

  const outcomes = [];
  for (const row of pending) {
    try {
      const outcome = await processRow(row, h, apiKey);
      outcomes.push(outcome);
    } catch (e) {
      console.error('worker.processRow:', e.message);
      outcomes.push({ id: row.id, action: 'crash', error: e.message });
    }
  }

  // Per-action counts so monitoring can spot anomalies (lots of
  // 'failed' entries → Anthropic outage; lots of 'fin_skip' →
  // Fin activated upstream and we should investigate).
  const counts = outcomes.reduce(function (acc, o) {
    acc[o.action] = (acc[o.action] || 0) + 1;
    return acc;
  }, {});

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed: outcomes.length, counts, outcomes }),
  };
};

// Re-export pure helpers for tests.
exports.buildTriagePatch = buildTriagePatch;
exports.buildFinSkipPatch = buildFinSkipPatch;
exports.clearsSeverityThreshold = clearsSeverityThreshold;
exports.buildPrimaryEscalationPatch = buildPrimaryEscalationPatch;
exports.FIN_SKIP_NOTE = FIN_SKIP_NOTE;
