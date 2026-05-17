// netlify/functions/sla-sweep.js
//
// Pull-queue SLA sweep. Two independent windows:
//
//   24h from first_pulled_at — initial response SLA. When expired:
//     - due_state flips true (sticky-Due)
//     - claim is released (claimed_by + claimed_at null) so the
//       task returns to the pool. Any future puller sees it as Due
//       on arrival because due_state stays true.
//
//   8h from last_patient_reply_at — reply SLA. When expired:
//     - due_state flips true
//     - last_patient_reply_at is cleared so this sweep doesn't
//       refire on the same patient turn
//     - the claim is NOT released; the staffer still owns the task
//       and sees it as Due in their queue. They can retask if they
//       can't get to it.
//
// Migration 0022 indexes both columns with partial-index WHERE
// clauses that match these predicates, so each scan is cheap.
//
// Sticky-Due: once due_state is true, it stays true across re-pulls
// and re-tasks until the task closes (status transitions to 'sent',
// 'closed', etc.).
//
// Race safety: each PATCH filters on the predicate that defines
// "still expired" — for 24h sweep, `due_state=eq.false`; for 8h,
// `last_patient_reply_at=not.is.null`. If a parallel write moved
// the row out of the expired state between fetch and PATCH, the
// PATCH returns zero rows and we skip the audit.
//
// Known gap: nothing in the current code SETS `last_patient_reply_at`
// yet — the 8h sweep is ready but won't fire in practice until the
// flow that handles patient replies on existing tasks lands. The
// column, index, and sweep all exist so that wiring is a small
// future change rather than a substrate change.
//
// Invocation: not scheduled yet (per ROADMAP Week 4). Today the
// function is invokable manually via HTTP, which is enough for
// beta dev + ops.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const SLA_24H_MS = 24 * 60 * 60 * 1000;
const SLA_8H_MS = 8 * 60 * 60 * 1000;

// Bound the worst-case scan size per sweep call. If we have more
// than 50 expired rows in a single sweep window, we'll process
// the next batch on the following invocation — better than letting
// a single call run for minutes.
const SWEEP_BATCH_SIZE = 50;

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
    console.error('sla-sweep.audit:', e.message);
  }
}

// ── Pure helpers (exported for tests) ──────────────────────────────

// Is the 24h initial-response SLA expired for a given first_pulled_at?
// Mirrors the SQL filter `first_pulled_at < (now - 24h)`. Strictly
// greater than 24h elapsed — at exactly 24h, the SLA hasn't fired
// yet. Null/invalid inputs return false (column-not-set means the
// task was never pulled; SLA can't expire on it).
function isExpired24h(firstPulledAt, now) {
  if (firstPulledAt == null) return false;
  const t = typeof firstPulledAt === 'number'
    ? firstPulledAt
    : new Date(firstPulledAt).getTime();
  if (isNaN(t)) return false;
  return (now - t) > SLA_24H_MS;
}

// Is the 8h patient-reply SLA expired for a given last_patient_reply_at?
// Same semantics as isExpired24h — strictly greater than 8h elapsed.
function isExpired8h(lastPatientReplyAt, now) {
  if (lastPatientReplyAt == null) return false;
  const t = typeof lastPatientReplyAt === 'number'
    ? lastPatientReplyAt
    : new Date(lastPatientReplyAt).getTime();
  if (isNaN(t)) return false;
  return (now - t) > SLA_8H_MS;
}

// PATCH payload for a 24h-SLA-expired row. Sticky-Due + release the
// claim so the task returns to the pool.
function build24hSweepPatch() {
  return {
    due_state: true,
    claimed_by: null,
    claimed_at: null,
  };
}

// PATCH payload for an 8h-SLA-expired row. Sticky-Due + clear the
// reply anchor so this sweep doesn't refire on the same patient
// turn. The claim is preserved — the assigned staffer still owns
// the task; the SLA just made it visibly Due in their queue.
function build8hSweepPatch() {
  return {
    due_state: true,
    last_patient_reply_at: null,
  };
}

// ── Sweep operations ──────────────────────────────────────────────

async function sweep24h(now, h) {
  // SQL tri-valued logic: `first_pulled_at < X` automatically
  // excludes null rows, so the additional `is.null` guard isn't
  // necessary. `claimed_by=not.is.null` matches the index's WHERE
  // clause and prunes the scan.
  const threshold = new Date(now - SLA_24H_MS).toISOString();
  let candidates;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history`
        + `?claimed_by=not.is.null`
        + `&due_state=eq.false`
        + `&first_pulled_at=lt.${encodeURIComponent(threshold)}`
        + `&select=id,company_id,first_pulled_at`
        + `&limit=${SWEEP_BATCH_SIZE}`,
      { headers: h }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('sla-sweep.24h.fetch:', r.status, body.slice(0, 200));
      return { expired: 0, errors: 1 };
    }
    candidates = await r.json();
  } catch (e) {
    console.error('sla-sweep.24h.fetch:', e.message);
    return { expired: 0, errors: 1 };
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { expired: 0, errors: 0 };
  }

  const patch = build24hSweepPatch();
  let expired = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      // The `due_state=eq.false` predicate makes the PATCH a no-op
      // if a parallel sweep already fired on this row. Returns
      // [] in that case; we don't double-audit.
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/query_history`
          + `?id=eq.${encodeURIComponent(row.id)}`
          + `&due_state=eq.false`,
        {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        }
      );
      if (!r.ok) {
        errors++;
        continue;
      }
      const updated = await r.json();
      if (Array.isArray(updated) && updated.length > 0) {
        expired++;
        await audit({
          company_id: row.company_id,
          actor_name: 'sla-sweep',
          event_type: 'sla.24h_expired',
          entity_type: 'query_history',
          entity_id: row.id,
          payload: { first_pulled_at: row.first_pulled_at },
        }, h);
      }
    } catch (e) {
      console.error('sla-sweep.24h.patch:', e.message);
      errors++;
    }
  }

  return { expired, errors };
}

async function sweep8h(now, h) {
  const threshold = new Date(now - SLA_8H_MS).toISOString();
  let candidates;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history`
        + `?claimed_by=not.is.null`
        + `&last_patient_reply_at=lt.${encodeURIComponent(threshold)}`
        + `&select=id,company_id,last_patient_reply_at`
        + `&limit=${SWEEP_BATCH_SIZE}`,
      { headers: h }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('sla-sweep.8h.fetch:', r.status, body.slice(0, 200));
      return { expired: 0, errors: 1 };
    }
    candidates = await r.json();
  } catch (e) {
    console.error('sla-sweep.8h.fetch:', e.message);
    return { expired: 0, errors: 1 };
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { expired: 0, errors: 0 };
  }

  const patch = build8hSweepPatch();
  let expired = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      // The `last_patient_reply_at=not.is.null` predicate makes
      // the PATCH a no-op if a parallel sweep, staff send, or
      // similar already cleared the reply anchor on this row.
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/query_history`
          + `?id=eq.${encodeURIComponent(row.id)}`
          + `&last_patient_reply_at=not.is.null`,
        {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        }
      );
      if (!r.ok) {
        errors++;
        continue;
      }
      const updated = await r.json();
      if (Array.isArray(updated) && updated.length > 0) {
        expired++;
        await audit({
          company_id: row.company_id,
          actor_name: 'sla-sweep',
          event_type: 'sla.8h_expired',
          entity_type: 'query_history',
          entity_id: row.id,
          payload: { last_patient_reply_at: row.last_patient_reply_at },
        }, h);
      }
    } catch (e) {
      console.error('sla-sweep.8h.patch:', e.message);
      errors++;
    }
  }

  return { expired, errors };
}

// ── Handler ────────────────────────────────────────────────────────

exports.handler = async function () {
  if (!SUPABASE_URL || !(SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)) {
    return { statusCode: 500, body: 'Supabase not configured' };
  }
  const h = writeHeaders();
  const now = Date.now();

  // Run sequentially (not in parallel) — they may both PATCH the
  // same row's due_state, and PostgREST doesn't expose row-level
  // locks. Sequential keeps reasoning simple and the audit log
  // ordering deterministic.
  const r24 = await sweep24h(now, h);
  const r8 = await sweep8h(now, h);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ran_at: new Date(now).toISOString(),
      sweep_24h: r24,
      sweep_8h: r8,
    }),
  };
};

// Re-export pure helpers + constants for tests.
exports.SLA_24H_MS = SLA_24H_MS;
exports.SLA_8H_MS = SLA_8H_MS;
exports.isExpired24h = isExpired24h;
exports.isExpired8h = isExpired8h;
exports.build24hSweepPatch = build24hSweepPatch;
exports.build8hSweepPatch = build8hSweepPatch;
