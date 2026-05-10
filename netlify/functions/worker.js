// netlify/functions/worker.js
// Background processor for query_history rows in status='pending'. Runs
// the triage against the per-tenant KB and transitions to status='triaged'.
//
// Invocation options (pick one when wiring up):
//   1. Netlify scheduled function (netlify.toml):
//        [[scheduler]] path = "/.netlify/functions/worker"
//        schedule = "* * * * *"
//   2. Supabase pg_cron hitting the function URL on a schedule.
//   3. External cron (GitHub Actions, Inngest) that POSTs to the URL.
//
// This is a stub: it dequeues, but it does not yet call the Anthropic
// API directly. Plumb the real triage call once the first inbound
// channel adapter (Bask, email, Healthie, etc.) is ready to feed
// pending rows in. Until then the worker only proves the queue
// drains and leaves a triage_skipped audit entry.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const WORKER_BATCH_SIZE = 5;

function writeHeaders() {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  return {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': 'Bearer ' + key,
  };
}

async function audit(entry) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ...writeHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error('worker.audit:', e.message);
  }
}

exports.handler = async function () {
  if (!SUPABASE_URL || !(SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)) {
    return { statusCode: 500, body: 'Supabase not configured' };
  }

  const h = writeHeaders();

  // Pick up pending rows oldest-first. There's no explicit row lock;
  // we minimize race risk by transitioning to 'triaged' in the very
  // next PATCH below. If two workers race on the same row, the second
  // PATCH is a no-op rewrite of an already-triaged row — wasted work
  // but not a correctness issue. When real triage calls land here,
  // add a `for update skip locked`-style claim (or use Postgres
  // advisory locks via a Supabase RPC) before going to higher
  // concurrency.
  let pending;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/query_history?status=eq.pending&created_at=lt.${encodeURIComponent(new Date().toISOString())}&order=created_at.asc&limit=${WORKER_BATCH_SIZE}`,
      { headers: h }
    );
    pending = await r.json();
  } catch (e) {
    console.error('worker.fetchPending:', e.message);
    return { statusCode: 500, body: e.message };
  }

  if (!Array.isArray(pending) || pending.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ processed: 0, message: 'queue empty' }) };
  }

  let processed = 0;
  for (const row of pending) {
    try {
      // TODO: call the triage proxy here once the first inbound
      // channel adapter (Bask, email, Healthie, ...) is feeding rows
      // in. For now, mark as triaged with a placeholder note so the
      // queue drains and the audit trail records what happened.
      const patch = {
        status: 'triaged',
        draft_response: row.draft_response || '[worker stub — triage call not yet wired]',
      };
      await fetch(`${SUPABASE_URL}/rest/v1/query_history?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      await audit({
        company_id: row.company_id,
        actor_name: 'worker',
        event_type: 'triage.skip_stub',
        entity_type: 'query_history',
        entity_id: row.id,
        payload: { external_id: row.external_id || null },
      });
      processed++;
    } catch (e) {
      console.error('worker.process:', e.message);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed, total_seen: pending.length }),
  };
};
