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
//   POST /queue/reassign — log a category correction (learning signal).
//                          Updates clinical_category + writes a
//                          task_reassignments row. Does NOT release
//                          ownership; caller keeps the task.
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

const { isOutboundLiveMode } = require("../safety");

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
  'conversation_id',
  'patient_message', 'patient_email', 'patient_name',
  'draft_response',
  'clinical_category', 'urgency_score', 'urgency_original',
  'urgency_override',
  'clinical_routing_level', 'ai_confidence', 'internal_note',
  'parent_task_id',
  'claimed_by', 'claimed_at', 'first_pulled_at',
  'last_patient_reply_at', 'due_state',
  'upvoted', 'downvoted', 'upvote_reason', 'downvote_reason',
  'actual_response_sent',
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
//   1. Severe (urgency_score >= threshold) first — high SE always
//      wins regardless of categorical urgency.
//   2. Due tasks next.
//   3. Categorical urgency: urgent > same-day > routine > none.
//      Added 2026-05-17 — without this rank a non-severe Routine with
//      a slightly higher SE score could outrank a Same-day with a
//      lower score (Brad observed routine sorting above same-day).
//   4. urgency_score (tie-break within same urgency category).
//   5. created_at (oldest first, final tie-break).
//
// Factory form: the threshold is injected so the comparator is
// pure and unit-testable without depending on the RELAI_DEFAULTS
// global. `taskPriorityCmp` below binds the tenant default.
function urgencyOriginalRank(u) {
  switch ((u || '').toLowerCase()) {
    case 'urgent':   return 3;
    case 'same-day': return 2;
    case 'routine':  return 1;
    default:         return 0;
  }
}

function makeTaskPriorityCmp(severityThreshold) {
  return function (a, b) {
    const aSevere = (a.urgency_score || 0) >= severityThreshold ? 1 : 0;
    const bSevere = (b.urgency_score || 0) >= severityThreshold ? 1 : 0;
    if (aSevere !== bSevere) return bSevere - aSevere;
    const aDue = a.due_state ? 1 : 0;
    const bDue = b.due_state ? 1 : 0;
    if (aDue !== bDue) return bDue - aDue;
    // Categorical urgency. urgency_override wins when set (matches
    // the detail-view "curUrgency" semantics) so that staff
    // re-classifications take effect in the queue order.
    const aU = urgencyOriginalRank(a.urgency_override || a.urgency_original);
    const bU = urgencyOriginalRank(b.urgency_override || b.urgency_original);
    if (aU !== bU) return bU - aU;
    const aUrg = a.urgency_score || 0;
    const bUrg = b.urgency_score || 0;
    if (aUrg !== bUrg) return bUrg - aUrg;
    // Older first.
    const aCreated = a.created_at || '';
    const bCreated = b.created_at || '';
    return aCreated < bCreated ? -1 : aCreated > bCreated ? 1 : 0;
  };
}

const taskPriorityCmp = makeTaskPriorityCmp(RELAI_DEFAULTS.severityUrgencyThreshold);

// ─────────────────────────────────────────────────────────────────
// Pure helpers (validators + precondition + eligibility split)
// ─────────────────────────────────────────────────────────────────
//
// These are the protocol decision points pulled out of the handler
// bodies so they can be unit-tested without a Supabase mock. Each
// returns a plain shape; the handlers translate that shape into a
// JSON response.

// POST /queue/pull body shape.
function parsePullBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const requested = Array.isArray(body.categories)
    ? body.categories.filter(s => typeof s === 'string')
    : [];
  if (requested.length === 0) {
    return { ok: false, error: 'Provide at least one category in `categories[]` to pull from.' };
  }
  return { ok: true, categories: requested };
}

// POST /queue/retask body shape.
function parseRetaskBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  if (!triageId) return { ok: false, error: 'Missing or invalid `triage_id`.' };
  return { ok: true, triageId };
}

// POST /queue/reassign body shape. The note cap (1000 chars) is
// also enforced here so the test suite pins it down.
function parseReassignBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  const newCategory = typeof body.new_category === 'string' ? body.new_category.trim() : '';
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : null;
  if (!triageId) return { ok: false, error: 'Missing or invalid `triage_id`.' };
  if (!newCategory) return { ok: false, error: 'Missing or invalid `new_category`.' };
  return { ok: true, triageId, newCategory, note };
}

// POST /queue/vote body shape. `vote` must be 'up' or 'down';
// reason is optional and capped (defensive). The handler writes the
// result to query_history's upvoted / downvoted / upvote_reason /
// downvote_reason columns which existed since 0001_baseline as
// reward-signal columns for the learning loop.
function parseVoteBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  const vote = typeof body.vote === 'string' ? body.vote.trim().toLowerCase() : '';
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
  if (!triageId) return { ok: false, error: 'Missing or invalid `triage_id`.' };
  if (vote !== 'up' && vote !== 'down') {
    return { ok: false, error: 'Vote must be "up" or "down".' };
  }
  return { ok: true, triageId, vote, reason };
}

// POST /queue/close-no-reply body shape. Closes a task terminally
// without sending a patient-facing reply. Note is required (non-empty
// after trim) — the audit trail and any downstream picker depend on
// the why-was-this-closed text.
function parseCloseNoReplyBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!triageId) return { ok: false, error: 'Missing or invalid `triage_id`.' };
  if (!note) return { ok: false, error: 'Missing or empty `note`. A close note is required so the close reason is captured.' };
  if (note.length > 4000) return { ok: false, error: 'note exceeds 4000 char cap.' };
  return { ok: true, triageId, note };
}

// POST /queue/spawn-followup body shape. Creates a child task tied
// to a parent via parent_task_id. The child enters status
// 'pending_parent' and stays out of all queues until the parent
// terminates. Note is required so the receiving staffer knows what
// the originator wants done.
function parseSpawnFollowupBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const parentId = typeof body.parent_id === 'string' ? body.parent_id.trim() : '';
  const targetCategory = typeof body.target_category === 'string' ? body.target_category.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const draftResponse = typeof body.draft_response === 'string' ? body.draft_response : '';
  // patient_facing defaults to true (per the design choice 2026-05-17).
  // Accept explicit false; coerce anything else to true.
  const patientFacing = body.patient_facing === false ? false : true;
  if (!parentId) return { ok: false, error: 'Missing or invalid `parent_id`.' };
  if (!targetCategory) return { ok: false, error: 'Missing or invalid `target_category`.' };
  if (!note) return { ok: false, error: 'Missing or empty `note`. The receiving staffer needs to know what to do.' };
  if (note.length > 4000) return { ok: false, error: 'note exceeds 4000 char cap.' };
  if (draftResponse.length > 50000) return { ok: false, error: 'draft_response exceeds 50000 char cap.' };
  return { ok: true, parentId, targetCategory, note, draftResponse, patientFacing };
}

// POST /queue/send body shape. `maxTextLen` is injected so tests
// can exercise the boundary cheaply without producing 50k-char
// fixtures.
function parseSendBody(body, maxTextLen) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  const triageId = typeof body.triage_id === 'string' ? body.triage_id.trim() : '';
  const finalText = typeof body.final_text === 'string' ? body.final_text : '';
  if (!triageId) return { ok: false, error: 'Missing or invalid `triage_id`.' };
  if (!finalText) return { ok: false, error: 'Missing or empty `final_text`.' };
  if (finalText.length > maxTextLen) {
    return { ok: false, error: 'final_text exceeds ' + maxTextLen + ' char cap.' };
  }
  return { ok: true, triageId, finalText };
}

// Strict-batch refill + sticky-Due queue-lock check.
//
// Returns { proceed: true } when the caller has zero open tasks,
// or { proceed: false, status, body } describing the 409 response
// the handler should return. The two reasons are 'queue_lock_due'
// (5 Due tasks held — must clear before pulling) and 'strict_batch'
// (still working through current queue).
function checkPullPrecondition(myOpen, queueCap) {
  if (!Array.isArray(myOpen) || myOpen.length === 0) return { proceed: true };
  const dueCount = myOpen.filter(t => t && t.due_state === true).length;
  if (dueCount >= queueCap) {
    return {
      proceed: false,
      status: 409,
      body: {
        error: 'Queue locked: ' + dueCount + ' of ' + queueCap + ' tasks are Due. Clear or re-task at least one before pulling.',
        reason: 'queue_lock_due',
        due_count: dueCount,
      },
    };
  }
  return {
    proceed: false,
    status: 409,
    body: {
      error: 'Strict-batch refill: finish your current queue before pulling more.',
      reason: 'strict_batch',
      pending_count: myOpen.length,
    },
  };
}

// Partition requested category names by eligibility for the caller.
// Unknown (not in this tenant's category_metadata) and 'never'
// categories drop silently — the staff member's dropdown never
// shows them either way. The 'unknown' bucket is returned for
// debugging / audit; the handler ignores it.
function splitCategoriesByEligibility(profile, requested, categoriesMeta, defaults) {
  const granted = [];
  const idleOnly = [];
  const unknown = [];
  if (!Array.isArray(requested)) return { granted, idleOnly, unknown };
  for (const name of requested) {
    const meta = categoriesMeta && categoriesMeta[name];
    if (!meta) { unknown.push(name); continue; }
    const elig = categoryEligibility(profile, name, meta.is_clinical, defaults);
    if (elig === 'always') granted.push(name);
    else if (elig === 'idle_only') idleOnly.push(name);
    // 'never' → silently drop
  }
  return { granted, idleOnly, unknown };
}

// Partition candidate rows by whether they've been pulled before.
// Used in the two-PATCH claim batch: rows with first_pulled_at IS
// NULL get the anchor set (first pull); rows with it already set
// preserve the original anchor (re-pull after re-tasking or SLA
// release).
function partitionForClaim(candidates) {
  const firstTime = [];
  const rePull = [];
  if (!Array.isArray(candidates)) return { firstTime, rePull };
  for (const row of candidates) {
    if (!row) continue;
    if (!row.first_pulled_at) firstTime.push(row);
    else rePull.push(row);
  }
  return { firstTime, rePull };
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

  const parsed = parsePullBody(parseBody(event));
  if (!parsed.ok) return json(400, { error: parsed.error });

  const companyId = profile.company_id;
  const h = writeHeaders();

  // Strict-batch refill + sticky-Due queue-lock checks.
  const mine = await fetchOwnOpenTasks(profile.id, companyId, h);
  const pre = checkPullPrecondition(mine, QUEUE_CAP);
  if (!pre.proceed) return json(pre.status, pre.body);

  // Resolve which requested categories the caller is eligible for.
  const categoriesMeta = await fetchCategoriesMeta(companyId, h);
  const { granted, idleOnly } = splitCategoriesByEligibility(
    profile, parsed.categories, categoriesMeta, RELAI_DEFAULTS
  );

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
  const { firstTime, rePull } = partitionForClaim(candidates);

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

  // Skip the PATCH when its partition is empty — avoids two
  // round-trips on every pull that happens to be all-rePull or
  // all-firstTime.
  const firstClaimed = firstTime.length > 0
    ? await claimBatch(
        '&first_pulled_at=is.null',
        { claimed_by: profile.id, claimed_at: now, first_pulled_at: now }
      )
    : [];
  const secondClaimed = rePull.length > 0
    ? await claimBatch(
        '&first_pulled_at=not.is.null',
        { claimed_by: profile.id, claimed_at: now }
      )
    : [];
  const claimed = firstClaimed.concat(secondClaimed);

  claimed.sort(taskPriorityCmp);

  auditLog(h, {
    company_id: companyId,
    actor_id: profile.id,
    event_type: 'queue.pull',
    entity_type: 'query_history',
    payload: {
      requested_categories: parsed.categories,
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

  const parsed = parseRetaskBody(parseBody(event));
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { triageId } = parsed;

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

  // Drop any pending_parent children of this parent. Per the
  // 2026-05-17 design choice: releasing the parent means the work was
  // abandoned, so the staged follow-ups go with it. If they should
  // stick around, the staffer should send or close-no-reply instead.
  const dropped = await deleteChildren(triageId, profile.company_id, h);

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.retask',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: {
      due_state: updated[0].due_state,
      followups_dropped: dropped.count,
    },
  });

  return json(200, { ok: true, followups_dropped: dropped.count });
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/reassign
// ─────────────────────────────────────────────────────────────────

async function handleReassign(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const parsed = parseReassignBody(parseBody(event));
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { triageId, newCategory, note } = parsed;

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

  // Apply: change category only. Ownership stays with the caller —
  // reassignment is a learning signal (recorded in task_reassignments
  // below), not a hand-off. Staff who want to release should use
  // /queue/retask.
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
  // Sandbox kill-switch: until OUTBOUND_LIVE_MODE=true is set in the
  // Netlify environment, NO channel ever sees a live network call.
  // Default-off means a deploy can't accidentally send to a real
  // patient. The manual channel passes through (no external API call
  // anyway — staff handles the actual send themselves). See
  // _lib/safety.js. Every channel module added in the future
  // inherits this gate by virtue of going through dispatchOutbound.
  if (channel !== 'manual' && !isOutboundLiveMode()) {
    console.log('queue.send.dispatch.sandboxed:', {
      channel: channel, triage_id: task && task.id,
    });
    return { ok: true, sent_via: 'sandbox:' + channel, sandboxed: true };
  }

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
      // Stub. Week 4 wires the real adapter. NB: this path is only
      // reachable when OUTBOUND_LIVE_MODE=true; the sandbox gate
      // above catches every test/dev deploy.
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

  const parsed = parseSendBody(parseBody(event), SEND_TEXT_MAX);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { triageId, finalText } = parsed;

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

  // Fire any pending_parent children of this parent. They flip to
  // 'triaged' and enter their target categories' queues.
  const fired = await fireChildren(triageId, profile.company_id, h);

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.send',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: {
      sent_via: dispatch.sent_via,
      text_length: finalText.length,
      followups_fired: fired.count,
      followup_categories: fired.categories,
    },
  });

  return json(200, {
    ok: true,
    sent_via: dispatch.sent_via,
    followups_fired: fired.count,
    followup_categories: fired.categories,
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/vote
// ─────────────────────────────────────────────────────────────────
//
// Records staff feedback on the AI's draft. Upvote ↔ downvote are
// mutually exclusive at the row level; voting one way clears the
// other. The columns (upvoted, downvoted, upvote_reason,
// downvote_reason) existed since 0001_baseline as reward-signal
// inputs to the learning loop. The /queue/vote surface just makes
// them writable from the new tasking SPA.
//
// Caller must own (claimed_by = caller) OR have voted before — the
// vote write is allowed for any task in the caller's tenant since
// the reward signal isn't sensitive (staff seeing each other's
// votes is fine; correcting your own is allowed; voting a task you
// don't currently own happens during retrospectives).

async function handleVote(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const parsed = parseVoteBody(parseBody(event));
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { triageId, vote, reason } = parsed;

  const h = writeHeaders();

  // Mutually exclusive: voting one way clears the other.
  const patch = vote === 'up'
    ? { upvoted: true,  downvoted: false, upvote_reason: reason, downvote_reason: null }
    : { upvoted: false, downvoted: true,  upvote_reason: null,   downvote_reason: reason };

  // Tenant-scoped update. Ownership is NOT required (see header
  // comment above); only tenant scoping. If the row doesn't exist
  // in the caller's tenant, the PATCH returns [] and we 404.
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(triageId)}`
    + `&company_id=eq.${encodeURIComponent(profile.company_id)}`;

  let updated = [];
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows)) updated = rows;
    }
  } catch (e) {
    console.error('queue.vote:', e.message);
    return json(500, { error: 'Internal error recording vote.' });
  }

  if (updated.length === 0) {
    return json(404, { error: 'Task not found in your tenant.' });
  }

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.vote',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: { vote: vote, has_reason: !!reason },
  });

  return json(200, { ok: true, vote: vote });
}

// ─────────────────────────────────────────────────────────────────
// Follow-up task helpers
// ─────────────────────────────────────────────────────────────────
//
// Two shared operations on the parent-child relationship:
//
//   * fireChildren(parentId, companyId, h)  — flip pending_parent
//     children of a closing parent into 'triaged' so they enter
//     their target category's queue. Called from /queue/send and
//     /queue/close-no-reply after the parent's state transition.
//
//   * deleteChildren(parentId, companyId, h) — hard-delete
//     pending_parent children of a parent that's being released.
//     Per the 2026-05-17 design choice: release means the work was
//     abandoned, so the staged follow-ups go with it.
//
// Both are scoped to the tenant (company_id) AND require the child
// to be in pending_parent — so a stale parent_id pointing at an
// unrelated row can't accidentally affect already-active tasks.

async function fireChildren(parentId, companyId, h) {
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?parent_task_id=eq.${encodeURIComponent(parentId)}`
    + `&company_id=eq.${encodeURIComponent(companyId)}`
    + `&status=eq.pending_parent`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'triaged' }),
    });
    if (!r.ok) {
      console.error('queue.fireChildren:', r.status);
      return { count: 0, categories: [] };
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) return { count: 0, categories: [] };
    const categories = Array.from(new Set(
      rows.map(row => row && row.clinical_category).filter(Boolean)
    ));
    return { count: rows.length, categories: categories };
  } catch (e) {
    console.error('queue.fireChildren:', e.message);
    return { count: 0, categories: [] };
  }
}

async function deleteChildren(parentId, companyId, h) {
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?parent_task_id=eq.${encodeURIComponent(parentId)}`
    + `&company_id=eq.${encodeURIComponent(companyId)}`
    + `&status=eq.pending_parent`;
  try {
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { ...h, Prefer: 'return=representation' },
    });
    if (!r.ok) {
      console.error('queue.deleteChildren:', r.status);
      return { count: 0 };
    }
    const rows = await r.json();
    return { count: Array.isArray(rows) ? rows.length : 0 };
  } catch (e) {
    console.error('queue.deleteChildren:', e.message);
    return { count: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/close-no-reply
// ─────────────────────────────────────────────────────────────────
//
// Closes a task terminally without sending a patient-facing reply.
// Required note is appended to internal_note so the close reason is
// captured in the row's audit trail. Triggers fireChildren so any
// follow-ups staged against this parent enter their target queues.

async function handleCloseNoReply(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const parsed = parseCloseNoReplyBody(parseBody(event));
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { triageId, note } = parsed;

  const h = writeHeaders();

  // Tenant + ownership scoped lookup. Same gate as handleSend — only
  // the staffer who has the task claimed can close it.
  const task = await fetchTask(triageId, profile.company_id, h);
  if (!task) return json(404, { error: 'Task not found.' });
  if (task.claimed_by !== profile.id) {
    return json(404, { error: 'Task not claimed by caller.' });
  }

  // Build the new internal_note. Append the close note as a labeled
  // block so the existing note (if any — e.g., AI routing breadcrumb)
  // is preserved and the close reason is clearly delineated.
  const closeBreadcrumb =
    'CLOSED WITHOUT REPLY by ' + (profile.full_name || profile.email || profile.id) +
    ' at ' + new Date().toISOString() + ':\n' + note;
  const newInternalNote = task.internal_note
    ? task.internal_note + '\n\n' + closeBreadcrumb
    : closeBreadcrumb;

  // Commit the state transition: mark closed_no_reply, append note,
  // release the claim (queue slot frees).
  const patchUrl = `${SUPABASE_URL}/rest/v1/query_history`
    + `?id=eq.${encodeURIComponent(triageId)}`
    + `&company_id=eq.${encodeURIComponent(profile.company_id)}`
    + `&claimed_by=eq.${encodeURIComponent(profile.id)}`;
  try {
    const r = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'closed_no_reply',
        internal_note: newInternalNote,
        claimed_by: null,
        claimed_at: null,
      }),
    });
    if (!r.ok) {
      console.error('queue.closeNoReply.patch:', r.status);
      return json(500, { error: 'Close failed.' });
    }
  } catch (e) {
    console.error('queue.closeNoReply.patch:', e.message);
    return json(500, { error: 'Internal error.' });
  }

  // Fire any pending_parent children of this parent. They flip to
  // 'triaged' and enter their target categories' queues.
  const fired = await fireChildren(triageId, profile.company_id, h);

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.close_no_reply',
    entity_type: 'query_history',
    entity_id: triageId,
    payload: {
      note_length: note.length,
      followups_fired: fired.count,
      followup_categories: fired.categories,
    },
  });

  return json(200, {
    ok: true,
    followups_fired: fired.count,
    followup_categories: fired.categories,
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /queue/spawn-followup
// ─────────────────────────────────────────────────────────────────
//
// Creates a child task tied to a parent via parent_task_id. The
// child enters status 'pending_parent' and is invisible to every
// queue until the parent closes via /queue/send or
// /queue/close-no-reply. At that moment fireChildren transitions
// the child to 'triaged' and it appears in the target category's
// pool.
//
// The patient_facing intent is recorded as a labeled line in
// internal_note so the receiving staffer can see whether the
// originator expects them to send a patient reply.

async function handleSpawnFollowup(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  const parsed = parseSpawnFollowupBody(parseBody(event));
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { parentId, targetCategory, note, draftResponse, patientFacing } = parsed;

  const h = writeHeaders();

  // Parent must exist, in the caller's tenant, claimed by caller.
  // (You can only spawn follow-ups for tasks you currently own —
  // mirrors the send/close gate. Cross-tenant spawn is impossible.)
  const parent = await fetchTask(parentId, profile.company_id, h);
  if (!parent) return json(404, { error: 'Parent task not found.' });
  if (parent.claimed_by !== profile.id) {
    return json(404, { error: 'Parent task not claimed by caller.' });
  }

  // Target category must exist in the tenant. Cross-tier spawning
  // (clinical → non-clinical, etc.) is explicitly allowed.
  const categoriesMeta = await fetchCategoriesMeta(profile.company_id, h);
  if (!categoriesMeta[targetCategory]) {
    return json(400, { error: 'Unknown target_category `' + targetCategory + '` for this tenant.' });
  }

  // Build the breadcrumb. The receiving staffer sees this verbatim
  // so it needs to be self-explanatory.
  const intentLabel = patientFacing ? 'patient-facing reply expected' : 'internal handoff only — no patient reply needed';
  const breadcrumb =
    'FOLLOW-UP TASK spawned from ' + parentId +
    ' by ' + (profile.full_name || profile.email || profile.id) +
    ' at ' + new Date().toISOString() + '.\n' +
    'Originator intent: ' + intentLabel + '.\n' +
    'Note: ' + note;

  // Insert the child. Inherits source_channel from the parent so the
  // receiving staffer can see which channel this thread came in
  // from, and patient_message is copied so the chat-bubble renders
  // properly in the detail view.
  //
  // external_id is deliberately NULL on follow-ups. The unique
  // (company_id, external_id) partial index in migration 0001 would
  // reject the insert if we copied parent.external_id (the parent
  // already owns that pair). And semantically, a follow-up is a
  // staff-authored internal task — it didn't originate from
  // Intercom or any other channel, so it shouldn't impersonate one.
  // The parent linkage lives in parent_task_id; the conversation
  // linkage (if/when we add a conversation_id column) is also via
  // the parent.
  const insertUrl = `${SUPABASE_URL}/rest/v1/query_history`;
  let inserted;
  try {
    const r = await fetch(insertUrl, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        company_id: profile.company_id,
        parent_task_id: parentId,
        status: 'pending_parent',
        source_channel: parent.source_channel || 'manual',
        external_id: null,
        patient_message: parent.patient_message || '',
        draft_response: draftResponse || null,
        clinical_category: targetCategory,
        internal_note: breadcrumb,
        // No AI triage on follow-ups — these are staff-authored.
        // urgency_score / urgency_original / ai_confidence stay null.
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('queue.spawnFollowup.insert:', r.status, txt.slice(0, 200));
      return json(500, { error: 'Follow-up create failed.' });
    }
    const rows = await r.json();
    inserted = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error('queue.spawnFollowup.insert:', e.message);
    return json(500, { error: 'Internal error.' });
  }

  auditLog(h, {
    company_id: profile.company_id,
    actor_id: profile.id,
    event_type: 'queue.spawn_followup',
    entity_type: 'query_history',
    entity_id: inserted ? inserted.id : null,
    payload: {
      parent_id: parentId,
      target_category: targetCategory,
      patient_facing: patientFacing,
      note_length: note.length,
      has_draft: !!draftResponse,
    },
  });

  return json(200, {
    ok: true,
    followup_id: inserted ? inserted.id : null,
    target_category: targetCategory,
  });
}

// ─────────────────────────────────────────────────────────────────
// GET /queue/thread?conversation_id=<id>
// ─────────────────────────────────────────────────────────────────
//
// Returns every query_history row in the conversation, tenant-scoped,
// ordered by created_at ascending. The tasking SPA's detail view
// renders this as the full chat thread so staff don't have to ask
// "what did the patient say last month" — they can scroll.
//
// Status is NOT filtered: closed_no_reply, sent, closed, and
// backfilled rows are all visible. The renderer decides how each is
// shown (patient/staff bubble, system note, etc.).
//
// Field shape mirrors TASK_FIELDS plus the columns the thread renderer
// needs (conversation_id, actual_response_sent, parent_task_id). The
// reduced payload keeps the network response tight when threads run
// long.

const THREAD_FIELDS = [
  'id', 'conversation_id', 'parent_task_id', 'status',
  'source_channel', 'external_id',
  'patient_message', 'patient_email', 'patient_name',
  'actual_response_sent', 'internal_note',
  'clinical_category', 'urgency_original', 'urgency_score',
  'nurse_name', 'claimed_by',
  'created_at',
].join(',');

async function handleThread(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });

  const caller = await authedCaller(event);
  if (caller.error) return caller.error;
  const { profile } = caller;

  // conversation_id arrives as a query-string parameter. The Netlify
  // event shape provides this pre-parsed at event.queryStringParameters.
  const qs = event.queryStringParameters || {};
  const conversationId = typeof qs.conversation_id === 'string' ? qs.conversation_id.trim() : '';
  if (!conversationId) {
    return json(400, { error: 'Missing or invalid `conversation_id` query parameter.' });
  }

  const h = writeHeaders();
  const url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?company_id=eq.${encodeURIComponent(profile.company_id)}`
    + `&conversation_id=eq.${encodeURIComponent(conversationId)}`
    + `&select=${THREAD_FIELDS}`
    + `&order=created_at.asc`;
  try {
    const r = await fetch(url, { headers: h });
    if (!r.ok) {
      console.error('queue.thread:', r.status);
      return json(500, { error: 'Thread load failed.' });
    }
    const rows = await r.json();
    return json(200, { rows: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    console.error('queue.thread:', e.message);
    return json(500, { error: 'Internal error.' });
  }
}

module.exports = {
  // HTTP handlers
  handlePull,
  handleMine,
  handleRetask,
  handleReassign,
  handleSend,
  handleVote,
  handleCloseNoReply,
  handleSpawnFollowup,
  handleThread,
  // Pure helpers (exported for unit tests; not used by the router)
  inFilter,
  makeTaskPriorityCmp,
  taskPriorityCmp,
  parsePullBody,
  parseRetaskBody,
  parseReassignBody,
  parseSendBody,
  parseVoteBody,
  parseCloseNoReplyBody,
  parseSpawnFollowupBody,
  checkPullPrecondition,
  splitCategoriesByEligibility,
  partitionForClaim,
  dispatchOutbound,
  fireChildren,
  deleteChildren,
  // Constants (exported for tests that reference them)
  OPEN_STATUSES,
  QUEUE_CAP,
  SEND_TEXT_MAX,
};
