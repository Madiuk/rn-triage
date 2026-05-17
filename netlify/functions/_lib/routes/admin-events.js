// _lib/routes/admin-events.js
//
// Super-user-gated observability endpoints. Three streams of system
// activity that staff need visibility into but that don't belong in
// the normal task queue:
//
//   GET /admin/events/inbound — every inbound webhook event we
//     captured (inbound_raw_event table, mig 0024). Includes the
//     raw_payload so super-users can inspect what Intercom (or any
//     future channel) actually sent us. Most useful for: "why
//     didn't this conversation produce a task?" investigations.
//
//   GET /admin/events/reviews — query_history rows that were routed
//     to status='reviewed' by the safety pipeline (parse_failed,
//     validation_failed, tripwire, haiku_disagree, fin_skip).
//     These won't appear in the regular pull queue because they
//     have no clinical_category in many cases; this view surfaces
//     them so a human can address them out-of-band.
//
//   GET /admin/events/errors — audit_log entries whose event_type
//     indicates a failure (triage.failed, queue.send.db_failure,
//     etc.). Distinct from "reviewed" tasks — those are deliberate
//     escalations; these are unexpected failures.
//
// Gating: caller must be is_super_user. Admin-but-not-super-user
// gets 403. The data is potentially sensitive (raw patient messages
// in inbound payloads, full audit trails) so the gate is the
// strongest existing role flag.

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
  isSuperUser,
} = require("../permissions");

// Default + hard-cap for `?limit=`. Server-side ceiling so a
// `?limit=99999` URL param can't blow up the response.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Sanity cap on `?offset=`. Past a few thousand rows you're better
// off with a date filter anyway; this prevents pathological scrolling.
const MAX_OFFSET = 10000;

function parseLimit(event) {
  const q = ((event && event.queryStringParameters) || {}).limit;
  const n = parseInt(q, 10);
  if (!isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(event) {
  const q = ((event && event.queryStringParameters) || {}).offset;
  const n = parseInt(q, 10);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_OFFSET);
}

// Parse `?since=<ISO>` into a canonical UTC ISO string. Returns null
// for missing/invalid input (handlers treat null as "no filter").
// Strict format check first so a creative input can't slip through
// to PostgREST's query string — we still validate by round-tripping
// through `new Date()` but the regex is the first wall.
function parseSince(event) {
  const q = ((event && event.queryStringParameters) || {}).since;
  if (typeof q !== 'string' || !q) return null;
  // Loose ISO-8601 check: YYYY-MM-DD plus optional Tnn:nn[:nn[.ms]][Z|±nn:nn]
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+\-]\d{2}:\d{2})?)?$/.test(q)) return null;
  const d = new Date(q);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────
// GET /admin/events/inbound
// ─────────────────────────────────────────────────────────────────

async function handleInbound(event, ctx) {
  if (ctx.method !== 'GET') return json(405, { error: 'Method not allowed.' });
  const limit = parseLimit(event);
  const offset = parseOffset(event);
  const since = parseSince(event);
  const h = writeHeaders();

  // Newest-first. raw_payload is jsonb; PostgREST returns it inline.
  let url = `${SUPABASE_URL}/rest/v1/inbound_raw_event`
    + `?company_id=eq.${encodeURIComponent(ctx.callerCompanyId)}`
    + `&select=id,source_channel,topic,external_id,processed,processed_reason,triage_id,raw_payload,created_at`
    + `&order=created_at.desc`
    + `&limit=${limit}`
    + `&offset=${offset}`;
  if (since) url += `&created_at=gte.${encodeURIComponent(since)}`;
  try {
    const r = await fetch(url, { headers: h });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('admin-events.inbound:', r.status, body.slice(0, 200));
      return json(500, { error: 'Lookup failed.' });
    }
    const rows = await r.json();
    return json(200, {
      events: Array.isArray(rows) ? rows : [],
      limit, offset, since: since || null,
    });
  } catch (e) {
    console.error('admin-events.inbound:', e.message);
    return json(500, { error: 'Internal error.' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /admin/events/reviews
// ─────────────────────────────────────────────────────────────────
//
// query_history rows with status='reviewed' — the safety pipeline's
// escalation surface. These don't show in /queue/mine (the staffer
// hasn't claimed them) and they may have NULL clinical_category
// (parse_failed cases) so they don't pull through categories either.

async function handleReviews(event, ctx) {
  if (ctx.method !== 'GET') return json(405, { error: 'Method not allowed.' });
  const limit = parseLimit(event);
  const offset = parseOffset(event);
  const since = parseSince(event);
  const h = writeHeaders();

  let url = `${SUPABASE_URL}/rest/v1/query_history`
    + `?company_id=eq.${encodeURIComponent(ctx.callerCompanyId)}`
    + `&status=eq.reviewed`
    + `&select=id,source_channel,external_id,status,clinical_category,urgency_score,urgency_original,clinical_routing_level,internal_note,ai_confidence,patient_message,created_at,claimed_by`
    + `&order=created_at.desc`
    + `&limit=${limit}`
    + `&offset=${offset}`;
  if (since) url += `&created_at=gte.${encodeURIComponent(since)}`;
  try {
    const r = await fetch(url, { headers: h });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('admin-events.reviews:', r.status, body.slice(0, 200));
      return json(500, { error: 'Lookup failed.' });
    }
    const rows = await r.json();
    return json(200, {
      events: Array.isArray(rows) ? rows : [],
      limit, offset, since: since || null,
    });
  } catch (e) {
    console.error('admin-events.reviews:', e.message);
    return json(500, { error: 'Internal error.' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /admin/events/errors
// ─────────────────────────────────────────────────────────────────
//
// audit_log entries that indicate something went wrong. Filters
// by an allowlist of failure event_types so we don't surface every
// normal audit row (queue.pull, triage.complete, etc.).

const ERROR_EVENT_TYPES = [
  'triage.failed',
  'triage.patch_failed',
  'triage.fin_skip_failed',
  'queue.send.db_failure',
  'auth.first_admin_bootstrap',  // not an error but notable for super-user visibility
];

async function handleErrors(event, ctx) {
  if (ctx.method !== 'GET') return json(405, { error: 'Method not allowed.' });
  const limit = parseLimit(event);
  const offset = parseOffset(event);
  const since = parseSince(event);
  const h = writeHeaders();

  // PostgREST `in.(...)` filter with the allowlist.
  const inFilter = ERROR_EVENT_TYPES
    .map(s => '"' + encodeURIComponent(s) + '"')
    .join(',');
  let url = `${SUPABASE_URL}/rest/v1/audit_log`
    + `?company_id=eq.${encodeURIComponent(ctx.callerCompanyId)}`
    + `&event_type=in.(${inFilter})`
    + `&select=id,event_type,entity_type,entity_id,actor_name,actor_id,payload,created_at`
    + `&order=created_at.desc`
    + `&limit=${limit}`
    + `&offset=${offset}`;
  if (since) url += `&created_at=gte.${encodeURIComponent(since)}`;
  try {
    const r = await fetch(url, { headers: h });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('admin-events.errors:', r.status, body.slice(0, 200));
      return json(500, { error: 'Lookup failed.' });
    }
    const rows = await r.json();
    return json(200, {
      events: Array.isArray(rows) ? rows : [],
      limit, offset, since: since || null,
    });
  } catch (e) {
    console.error('admin-events.errors:', e.message);
    return json(500, { error: 'Internal error.' });
  }
}

// ─────────────────────────────────────────────────────────────────
// Top-level dispatcher
// ─────────────────────────────────────────────────────────────────

async function handle(event) {
  const path = event.path || '';
  const method = event.httpMethod;
  const token = extractToken(event);

  const user = await verifyUser(token);
  if (!user) return json(401, { error: 'Authentication required.' });

  const profile = await resolveProfile(user);
  if (!isSuperUser(profile)) {
    return json(403, { error: 'Super-user access required.', code: 'super_user_only' });
  }
  if (!profile.company_id) {
    return json(400, { error: 'Caller has no company_id.' });
  }

  const ctx = { method, callerProfile: profile, callerCompanyId: profile.company_id, user };

  if (path.includes('/admin/events/inbound')) return handleInbound(event, ctx);
  if (path.includes('/admin/events/reviews')) return handleReviews(event, ctx);
  if (path.includes('/admin/events/errors'))  return handleErrors(event, ctx);
  return json(404, { error: 'Unknown admin/events endpoint.' });
}

module.exports = {
  handle,
  // Pure helpers / constants exported for tests.
  parseLimit,
  parseOffset,
  parseSince,
  ERROR_EVENT_TYPES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_OFFSET,
};
