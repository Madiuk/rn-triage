// _lib/routes/queue.js
//
// Phase 3 pull-queue endpoints. Each handler is a thin wrapper
// around the existing _lib helpers (auth, supabase, permissions);
// the route file owns:
//
//   1. JSON body parse + shape validation
//   2. Strict-batch + sticky-Due queue-lock checks (POST /queue/pull)
//   3. Capability-based category filtering with idle-unlock
//   4. Optimistic claim via PATCH with `claimed_by=is.null` filter
//      (handles concurrent-pull races without locks)
//   5. Audit log entries (fire-and-forget; never block the response)
//
// What this file deliberately does NOT do:
//
//   - Modify the triage path. /triage, /ingest, /analyze are
//     untouched. queue.js consumes query_history rows that those
//     paths populate.
//   - Schedule the worker. Worker.js's real-triage call and
//     SLA-sweep job land in ROADMAP §1.3; until then nothing
//     auto-fires the queue-state transitions.
//   - Outbound dispatch for non-manual channels. /queue/send for
//     'intercom' / 'healthie' / 'bask' is stubbed pending Week 4.
//
// Endpoints:
//
//   POST /queue/pull     — fill caller's pending queue (≤5 tasks)
//   GET  /queue/mine     — caller's current pending queue
//   POST /queue/retask   — release a claim back to the pool
//   POST /queue/reassign — change category + release
//   POST /queue/send     — staff reply, transition to 'sent'
//
// See ROADMAP.md "Week 1 — Substrate" §1.2 for contracts and
// PLAN.md "Per-staff queue" / "Service-level windows and the
// Due state" / "Task ownership, assignment, and handoffs" for
// the protocol these endpoints enforce.

const {
  SUPABASE_URL,
  writeHeaders,
  json,
} = require("../supabase");

const {
  verifyUser,
  resolveProfile,
  extractToken,
} = require("../auth");

const {
  categoryEligibility,
} = require("../permissions");

const { RELAI_DEFAULTS } = require("../../../../data/defaults");

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

// Status values that mean "task still needs staff action." A
// staffer's pending queue contains only these. 'sent' is excluded:
// once sent, the task closes from the staffer's perspective and
// claimed_by is cleared in /queue/send. 'patient_replied' counts
// as open — the staffer owes a reply.
const OPEN_STATUSES = ['pending', 'triaged', 'reviewed', 'patient_replied'];

// Strict-batch refill cap. Matches PLAN.md "Per-staff queue".
const QUEUE_CAP = 5;

// Body length cap for /queue/send final_text. Defensive — staff
// messages should never get close to this, but uncapped writes are
// a free DoS surface.
const SEND_TEXT_MAX = 50000;

// Curated subset of query_history columns the SPA needs. Keeps
// payloads tight; the full row carries telemetry/cost fields the
// UI doesn't render.
const TASK_FIELDS = [
  'id', 'company_id', 'source_channel', 'external_id', 'status',
  'patient_message', 'draft_response',
  'clinical_category', 'urgency_score', 'urgency_original',
  'clinical_routing_level',
  'claimed_by', 'claimed_at', 'first_pulled_at',
  'last_patient_reply_at', 'due_state',
  'created_at',
].join(',');

// ─────────────────────────────────────────────────────────────────
// URL / filter helpers
// ─────────────────────────────────────────────────────────────────

// Build a Supabase REST `in.(...)` filter value. Each value is
// wrapped in double-quotes and URL-encoded so spaces / slashes /
// punctuation in category names (e.g. "Routing Hub",
// "Injection/Dosing") don't break the URL.
function inFilter(values) {
  return values
    .map(v => '"' + encodeURIComponent(String(v)) + '"')
    .join(',');
}

// ─────────────────────────────────────────────────────────────────
// DB read helpers
// ─────────────────────────────────────────────────────────────────

// Caller's currently-claimed open tasks. Used for the strict-batch
// refill check and as the GET /queue/mine payload.
async function fetchOwnOpenTasks(userId, companyId, h) {
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?company_id=eq.${encodeURIComponent(companyId)}`
    + `&claimed_by=eq.${encodeURIComponent(userId)}`
    + `&status=in.(${inFilter(OPEN_STATUSES)})`
    + `&select=${TASK_FIELDS}`
    + `&order=urgency_score.desc.nullslast,created_at.asc`;
  try {
    const r = await fetch(url, { headers: h });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('queue.fetchOwnOpenTasks:', e.message);
    return [];
  }
}

// Active category_metadata for the tenant, as a name → { is_clinical }
// map. The Routing Hub special category is augmented from defaults
// when category_metadata doesn't yet have it (the seed migration
// runs separately; until then, pulls can still reference Routing
// Hub by name).
async function fetchCategoriesMeta(companyId, h) {
  const map = {};
  // Always seed the routing hub from defaults so pull-eligibility
  // logic can resolve it even before the DB seed lands.
  if (RELAI_DEFAULTS.routingHubCategory) {
    map[RELAI_DEFAULTS.routingHubCategory] = { is_clinical: false };
  }
  try {
    const url = `${SUPABASE_URL}/rest/v1/category_metadata`
      + `?company_id=eq.${encodeURIComponent(companyId)}`
      + `&is_active=eq.true`
      + `&select=category_name,is_clinical`;
    const r = await fetch(url, { headers: h });
    if (!r.ok) return map;
    const rows = await r.json();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        map[row.category_name] = { is_clinical: !!row.is_clinical };
      }
    }
    return map;
  } catch (e) {
    console.error('queue.fetchCategoriesMeta:', e.message);
    return map;
  }
}

// Unclaimed open tasks in the given category list, ordered for
// priority. The 'severity-first' sort happens client-side here on
// the returned slice — Supabase REST doesn't easily express the
// `(urgency_score >= threshold) DESC` ordering.
async function fetchUnclaimedTasks(companyId, categoryNames, limit, h) {
  if (!Array.isArray(categoryNames) || categoryNames.length === 0) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/query_history`
      + `?company_id=eq.${encodeURIComponent(companyId)}`
      + `&claimed_by=is.null`
      + `&status=in.(${inFilter(OPEN_STATUSES)})`
      + `&clinical_category=in.(${inFilter(categoryNames)})`
      + `&select=${TASK_FIELDS}`
      + `&order=urgency_score.desc.nullslast,due_state.desc,created_at.asc`
      + `&limit=${limit}`;
    const r = await fetch(url, { headers: h });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('queue.fetchUnclaimedTasks:', e.message);
    return [];
  }
}

// Single task lookup, tenant-scoped. Returns null on miss or error.
async function fetchTask(triageId, companyId, h) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/query_history`
      + `?id=eq.${encodeURIComponent(triageId)}`
      + `&company_id=eq.${encodeURIComponent(companyId)}`
      + `&select=${TASK_FIELDS}`
      + `&limit=1`;
    const r = await fetch(url, { headers: h });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error('queue.fetchTask:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Sort
// ─────────────────────────────────────────────────────────────────

// Priority order for a staffer's queue display:
//   1. Severe (urgency_score >= threshold) first
//   2. Due tasks next
//   3. Then by urgency_score (high → low)
//   4. Tie-break by created_at (oldest first)
function taskPriorityCmp(a, b) {
  const threshold = RELAI_DEFAULTS.severityUrgencyThreshold;
  const aSevere = (a.urgency_score || 0) >= threshold ? 1 : 0;
  const bSevere = (b.urgency_score || 0) >= threshold ? 1 : 0;
  if (aSevere !== bSevere) return bSevere - aSevere;
  const aDue = a.due_state ? 1 : 0;
  const bDue = b.due_state ? 1 : 0;
  if (aDue !== bDue) return bDue - aDue;
  const aUrg = a.urgency_score || 0;
  const bUrg = b.urgency_score || 0;
  if (aUrg !== bUrg) return bUrg - aUrg;
  // Older first.
  const aCreated = a.created_at || '';
  const bCreated = b.created_at || '';
  return aCreated < bCreated ? -1 : aCreated > bCreated ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────
// Audit log (fire-and-forget)
// ─────────────────────────────────────────────────────────────────

function auditLog(h, entry) {
  fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify(entry),
  }).catch(e => console.error('queue.audit:', e.message));
}

// ─────────────────────────────────────────────────────────────────
// Shared handler preamble
// ─────────────────────────────────────────────────────────────────
//
// Most handlers share the same opening dance: verify JWT, resolve
// profile, check method, parse body. Centralize the auth/profile
// part; each handler does its own method + body checks since the
// rules differ per endpoint.

async function authedCaller(event) {
  const token = extractToken(event);
  const user = await verifyUser(token);
  if (!user) return { error: json(401, { error: 'Authentication required.' }) };
  const profile = await resolveProfile(user);
  if (!profile) return { error: json(404, { error: 'Profile not found.' }) };
  if (!profile.company_id) return { error: json(400, { error: 'Caller has no company_id.' }) };
  return { user, profile };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (e) {
    return null;  // signals "invalid JSON"
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/pull
// ─────────────────────────────────────────────────────────────────

async function handlePull(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const body = parseBody(event);
  if (body === null) return json(400, { error: 'Invalid JSON body.' });

  const requested = Array.isArray(body.categories) ? body.categories.filter(s => typeof s === 'string') : [];
  if (requested.length === 0) {
    return json(400, { error: 'Provide at least one category in `categories[]` to pull from.' });
  }

  const companyId = profile.company_id;
  const h = writeHeaders();

  // Strict-batch refill + sticky-Due queue-lock checks.
  const mine = await fetchOwnOpenTasks(profile.id, companyId, h);
  if (mine.length > 0) {
    const dueCount = mine.filter(t => t.due_state === true).length;
    if (dueCount >= QUEUE_CAP) {
      return json(409, {
        error: 'Queue locked: ' + dueCount + ' of ' + QUEUE_CAP + ' tasks are Due. Clear or re-task at least one before pulling.',
        reason: 'queue_lock_due',
        due_count: dueCount,
      });
    }
    return json(409, {
      error: 'Strict-batch refill: finish your current queue before pulling more.',
      reason: 'strict_batch',
      pending_count: mine.length,
    });
  }

  // Resolve which requested categories the caller is eligible for.
  const categoriesMeta = await fetchCategoriesMeta(companyId, h);
  const granted = [];
  const idleOnly = [];
  for (const name of requested) {
    const meta = categoriesMeta[name];
    if (!meta) continue;  // unknown to this tenant — drop silently
    const elig = categoryEligibility(profile, name, meta.is_clinical, RELAI_DEFAULTS);
    if (elig === 'always') granted.push(name);
    else if (elig === 'idle_only') idleOnly.push(name);
    // 'never' → drop silently
  }

  if (granted.length === 0 && idleOnly.length === 0) {
    return json(400, { error: 'No eligible categories in request. Check your role / title and the category list.' });
  }

  // Primary pull from "always" categories.
  let candidates = granted.length > 0
    ? await fetchUnclaimedTasks(companyId, granted, QUEUE_CAP, h)
    : [];
  let grantedForAudit = granted;
  let idleUnlockUsed = false;

  // Idle-unlock: if primary returned nothing AND idle categories are
  // available, retry against those. Mirrors the "Role and capability
  // gating" rule from PLAN.md.
  if (candidates.length === 0 && idleOnly.length > 0) {
    candidates = await fetchUnclaimedTasks(companyId, idleOnly, QUEUE_CAP, h);
    if (candidates.length > 0) {
      idleUnlockUsed = true;
      grantedForAudit = idleOnly;
    }
  }

  if (candidates.length === 0) {
    return json(200, { tasks: [], idle_unlock_used: false });
  }

  // Claim them. Two PATCHes are needed to handle the COALESCE on
  // first_pulled_at — Supabase REST can't express
  // `first_pulled_at = COALESCE(first_pulled_at, now())` in one call.
  //   Batch A: rows with first_pulled_at IS NULL → set it (first pull)
  //   Batch B: rows with first_pulled_at NOT NULL → preserve (re-pull)
  // The `&claimed_by=is.null` filter is the optimistic-claim guard:
  // a concurrent pull that already grabbed a row silently no-ops.
  const now = new Date().toISOString();
  const ids = candidates.map(c => c.id);
  const idList = ids.map(encodeURIComponent).join(',');

  async function claimBatch(extraFilter, payload) {
    const url = `${SUPABASE_URL}/rest/v1/query_history`
      + `?id=in.(${idList})`
      + `&company_id=eq.${encodeURIComponent(companyId)}`
      + `&claimed_by=is.null`
      + extraFilter;
    try {
      const r = await fetch(url, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return [];
      const rows = await r.json();
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.error('queue.claimBatch:', e.message);
      return [];
    }
  }

  const firstClaimed = await claimBatch(
    '&first_pulled_at=is.null',
    { claimed_by: profile.id, claimed_at: now, first_pulled_at: now }
  );
  const secondClaimed = await claimBatch(
    '&first_pulled_at=not.is.null',
    { claimed_by: profile.id, claimed_at: now }
  );
  const claimed = firstClaimed.concat(secondClaimed);

  claimed.sort(taskPriorityCmp);

  auditLog(h, {
    company_id: companyId,
    actor_id: profile.id,
    event_type: 'queue.pull',
    entity_type: 'query_history',
    payload: {
      requested_categories: requested,
      granted_categories: grantedForAudit,
      idle_unlock_used: idleUnlockUsed,
      task_ids: claimed.map(t => t.id),
      requested_count: candidates.length,
      claimed_count: claimed.length,
    },
  });

  return json(200, { tasks: claimed, idle_unlock_used: idleUnlockUsed });
}

// ─────────────────────────────────────────────────────────────────
// GET /queue/mine
// ─────────────────────────────────────────────────────────────────

async function handleMine(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const mine = await fetchOwnOpenTasks(profile.id, profile.company_id, writeHeaders());
  mine.sort(taskPriorityCmp);

  return json(200, { tasks: mine });
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/retask
// ─────────────────────────────────────────────────────────────────

async function handleRetask(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const body = parseBody(event);
  if (body === null) return json(400, { error: 'Invalid JSON body.' });
  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  if (!triageId) return json(400, { error: 'Missing or invalid `triage_id`.' });

  const h = writeHeaders();

  // Optimistic release with ownership guard. If the task isn't owned
  // by the caller (or doesn't exist in the tenant), the filter
  // excludes it and the PATCH returns []. We return 404 either way
  // — one-bit response, doesn't leak existence.
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(triageId)}`
    + `&company_id=eq.${encodeURIComponent(profile.company_id)}`
    + `&claimed_by=eq.${encodeURIComponent(profile.id)}`;

  let updated = [];
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({ claimed_by: null, claimed_at: null }),
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows)) updated = rows;
    }
  } catch (e) {
    console.error('queue.retask:', e.message);
    return json(500, { error: 'Internal error releasing task.' });
  }

  if (updated.length === 0) {
    return json(404, { error: 'Task not found or not claimed by caller.' });
  }

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.retask',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: { due_state: updated[0].due_state },
  });

  return json(200, { ok: true });
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/reassign
// ─────────────────────────────────────────────────────────────────

async function handleReassign(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const body = parseBody(event);
  if (body === null) return json(400, { error: 'Invalid JSON body.' });

  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  const newCategory = typeof body.new_category === 'string' ? body.new_category.trim() : '';
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : null;

  if (!triageId) return json(400, { error: 'Missing or invalid `triage_id`.' });
  if (!newCategory) return json(400, { error: 'Missing or invalid `new_category`.' });

  const h = writeHeaders();

  // Validate that new_category exists for the tenant.
  const categoriesMeta = await fetchCategoriesMeta(profile.company_id, h);
  if (!categoriesMeta[newCategory]) {
    return json(400, { error: 'Unknown category `' + newCategory + '` for this tenant.' });
  }

  // Capture the current category (for the audit + reassignment row).
  // Tenant-scoped + owned-by-caller; if either fails, we get null.
  const currentUrl = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(triageId)}`
    + `&company_id=eq.${encodeURIComponent(profile.company_id)}`
    + `&claimed_by=eq.${encodeURIComponent(profile.id)}`
    + `&select=id,clinical_category`
    + `&limit=1`;
  let current;
  try {
    const r = await fetch(currentUrl, { headers: h });
    if (!r.ok) return json(500, { error: 'Lookup failed.' });
    const rows = await r.json();
    current = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error('queue.reassign.lookup:', e.message);
    return json(500, { error: 'Internal error.' });
  }
  if (!current) {
    return json(404, { error: 'Task not found or not claimed by caller.' });
  }

  const fromCategory = current.clinical_category || null;

  // Apply: change category, release ownership.
  const patchUrl = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(triageId)}`
    + `&company_id=eq.${encodeURIComponent(profile.company_id)}`
    + `&claimed_by=eq.${encodeURIComponent(profile.id)}`;
  try {
    const r = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        clinical_category: newCategory,
        claimed_by: null,
        claimed_at: null,
      }),
    });
    if (!r.ok) {
      console.error('queue.reassign.patch:', r.status);
      return json(500, { error: 'Reassignment failed.' });
    }
  } catch (e) {
    console.error('queue.reassign.patch:', e.message);
    return json(500, { error: 'Internal error.' });
  }

  // Write the task_reassignments audit row (mig 0022 table).
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/task_reassignments`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        company_id: profile.company_id,
        triage_id: triageId,
        from_category: fromCategory,
        to_category: newCategory,
        actor_id: profile.id,
        actor_name: profile.full_name || null,
        note: note,
      }),
    });
  } catch (e) {
    // The reassignment is still applied; only the audit row failed.
    // Log and proceed.
    console.error('queue.reassign.auditRow:', e.message);
  }

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.reassign',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: {
      from_category: fromCategory,
      to_category: newCategory,
      has_note: !!note,
    },
  });

  return json(200, {
    ok: true,
    from_category: fromCategory,
    to_category: newCategory,
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/send
// ─────────────────────────────────────────────────────────────────
//
// v1 scope: handles state transition + audit. Outbound dispatch for
// non-manual channels (intercom, healthie, bask) is stubbed here
// pending Week 4 — `dispatchOutbound` returns success for now so
// the queue mechanics can be exercised end-to-end with manual or
// already-handled-elsewhere channels. When Week 4 wires real
// adapters, swap the stub for real `require("../channels/<name>")`
// calls.

async function dispatchOutbound(channel, task, finalText) {
  // Channel-specific outbound. v1 stub: log + return success for
  // all channels except those that explicitly aren't ready.
  switch (channel) {
    case 'manual':
      // Manual paste flow — staff already sent the reply somewhere
      // else; this endpoint is just for state bookkeeping.
      return { ok: true, sent_via: 'manual' };
    case 'intercom':
    case 'healthie':
    case 'bask':
    case 'email':
    case 'api':
      // Stub. Week 4 wires the real adapter.
      console.log('queue.send.dispatch.stub:', { channel, triage_id: task.id });
      return { ok: true, sent_via: channel + ':stub' };
    default:
      return { ok: false, error: 'Unknown channel: ' + channel };
  }
}

async function handleSend(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const body = parseBody(event);
  if (body === null) return json(400, { error: 'Invalid JSON body.' });

  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  const finalText = typeof body.final_text === 'string' ? body.final_text : '';
  if (!triageId) return json(400, { error: 'Missing or invalid `triage_id`.' });
  if (!finalText) return json(400, { error: 'Missing or empty `final_text`.' });
  if (finalText.length > SEND_TEXT_MAX) {
    return json(400, { error: 'final_text exceeds ' + SEND_TEXT_MAX + ' char cap.' });
  }

  const h = writeHeaders();

  // Tenant + ownership scoped lookup.
  const task = await fetchTask(triageId, profile.company_id, h);
  if (!task) return json(404, { error: 'Task not found.' });
  if (task.claimed_by !== profile.id) {
    return json(404, { error: 'Task not claimed by caller.' });
  }

  // Outbound dispatch (stubbed for non-manual in v1).
  let dispatch;
  try {
    dispatch = await dispatchOutbound(task.source_channel || 'manual', task, finalText);
  } catch (e) {
    console.error('queue.send.dispatch:', e.message);
    return json(502, { error: 'Channel adapter error: ' + e.message });
  }
  if (!dispatch.ok) {
    // Task stays claimed; staff can retry or re-task.
    return json(502, { error: dispatch.error || 'Channel adapter rejected the send.' });
  }

  // Commit the state transition: mark sent, persist actual text,
  // clear the 8h reply timer, release the claim (queue slot frees).
  const patchUrl = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(triageId)}`
    + `&company_id=eq.${encodeURIComponent(profile.company_id)}`
    + `&claimed_by=eq.${encodeURIComponent(profile.id)}`;
  try {
    const r = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'sent',
        actual_response_sent: finalText,
        last_patient_reply_at: null,  // cleared on staff send
        claimed_by: null,
        claimed_at: null,
      }),
    });
    if (!r.ok) {
      console.error('queue.send.patch:', r.status);
      // Adapter already accepted the send. The DB write failing
      // leaves a state inconsistency — flag in audit, surface 500.
      auditLog(h, {
        company_id: profile.company_id,
        actor_id: profile.id,
        event_type: 'queue.send.db_failure',
        entity_type: 'query_history',
        entity_id: triageId,
        payload: { sent_via: dispatch.sent_via, db_status: r.status },
      });
      return json(500, { error: 'Sent but state persistence failed.' });
    }
  } catch (e) {
    console.error('queue.send.patch:', e.message);
    return json(500, { error: 'Internal error after dispatch.' });
  }

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.send',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: {
      sent_via: dispatch.sent_via,
      text_length: finalText.length,
    },
  });

  return json(200, { ok: true, sent_via: dispatch.sent_via });
}

module.exports = {
  handlePull,
  handleMine,
  handleRetask,
  handleReassign,
  handleSend,
};
