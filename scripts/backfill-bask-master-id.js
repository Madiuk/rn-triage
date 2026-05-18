#!/usr/bin/env node
// scripts/backfill-bask-master-id.js
//
// One-off enrichment pass for query_history rows that have
// bask_patient_id (and ideally intercom_contact_id) but no
// bask_master_id yet — i.e., rows that landed before the migration
// 0035 enrichment was wired into the webhook handler.
//
// Lookup order per row:
//   1. If intercom_contact_id is set, fetch GET /contacts/{id} directly.
//   2. Otherwise, search by external_id (bask_patient_id) via
//      Intercom's POST /contacts/search, take the first hit.
//   3. Extract custom_attributes["order id"] (which Bask uses as the
//      Master ID), PATCH bask_master_id on the row.
//
// Idempotent — re-running is safe because the filter is
// `bask_master_id IS NULL`. Already-enriched rows are skipped.
//
// Required env vars (set these in your shell before running):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY        (service role key; needed to write)
//   INTERCOM_ACCESS_TOKEN
//
// Optional:
//   DRY_RUN=1                   — log what would change, write nothing
//   LIMIT=<n>                   — only process the first N rows
//
// Run:
//   node scripts/backfill-bask-master-id.js
//
// This script is not invoked by the app at runtime; it's an operator
// tool. Keep it small enough to read in one sitting.

const INTERCOM_API_VERSION = '2.11';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INTERCOM_ACCESS_TOKEN = process.env.INTERCOM_ACCESS_TOKEN;
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;

function bail(msg) {
  console.error('error:', msg);
  process.exit(1);
}

if (!SUPABASE_URL) bail('SUPABASE_URL not set');
if (!SUPABASE_SERVICE_KEY) bail('SUPABASE_SERVICE_KEY not set');
if (!INTERCOM_ACCESS_TOKEN) bail('INTERCOM_ACCESS_TOKEN not set');

const dbHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
};
const intercomHeaders = {
  'Authorization': 'Bearer ' + INTERCOM_ACCESS_TOKEN,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Intercom-Version': INTERCOM_API_VERSION,
};

async function fetchCandidates() {
  // Pull rows that have something we can look up with AND are missing
  // a master id. Order oldest-first so re-runs see the same sequence.
  const limitClause = LIMIT ? `&limit=${LIMIT}` : '';
  const url = SUPABASE_URL + '/rest/v1/query_history'
    + '?source_channel=eq.intercom'
    + '&bask_master_id=is.null'
    + '&or=(intercom_contact_id.not.is.null,bask_patient_id.not.is.null)'
    + '&select=id,bask_patient_id,intercom_contact_id,conversation_id'
    + '&order=created_at.asc'
    + limitClause;
  const r = await fetch(url, { headers: dbHeaders });
  if (!r.ok) throw new Error('DB read failed: ' + r.status + ' ' + await r.text());
  return r.json();
}

async function fetchContactById(contactId) {
  const r = await fetch(
    'https://api.intercom.io/contacts/' + encodeURIComponent(contactId),
    { headers: intercomHeaders }
  );
  if (!r.ok) {
    console.warn('  fetchContactById ' + contactId + ' failed: ' + r.status);
    return null;
  }
  return r.json();
}

async function searchContactByExternalId(externalId) {
  const r = await fetch('https://api.intercom.io/contacts/search', {
    method: 'POST',
    headers: intercomHeaders,
    body: JSON.stringify({
      query: { field: 'external_id', operator: '=', value: externalId },
    }),
  });
  if (!r.ok) {
    console.warn('  searchContactByExternalId ' + externalId + ' failed: ' + r.status);
    return null;
  }
  const body = await r.json();
  const data = body && body.data;
  return (Array.isArray(data) && data[0]) ? data[0] : null;
}

function extractMasterId(contact) {
  if (!contact || !contact.custom_attributes) return null;
  const v = contact.custom_attributes['order id'];
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

async function patchRow(rowId, patch) {
  if (DRY_RUN) return true;
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/query_history?id=eq.' + encodeURIComponent(rowId),
    {
      method: 'PATCH',
      headers: { ...dbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    }
  );
  if (!r.ok) {
    console.warn('  PATCH ' + rowId + ' failed: ' + r.status + ' ' + await r.text());
    return false;
  }
  return true;
}

async function main() {
  console.log('backfill-bask-master-id starting' + (DRY_RUN ? ' (DRY_RUN)' : ''));
  const candidates = await fetchCandidates();
  console.log('candidates:', candidates.length);

  // Cache by contact key (intercom_contact_id || bask_patient_id) so
  // we make at most one Intercom call per unique patient/contact.
  const cache = new Map();
  const counts = { updated: 0, no_contact: 0, no_master_id: 0, errors: 0 };

  for (const row of candidates) {
    const cacheKey = row.intercom_contact_id || ('ext:' + row.bask_patient_id);
    let contact;
    if (cache.has(cacheKey)) {
      contact = cache.get(cacheKey);
    } else {
      try {
        if (row.intercom_contact_id) {
          contact = await fetchContactById(row.intercom_contact_id);
        } else if (row.bask_patient_id) {
          contact = await searchContactByExternalId(row.bask_patient_id);
        }
      } catch (e) {
        console.warn('  lookup error for row ' + row.id + ': ' + e.message);
        counts.errors++;
        continue;
      }
      cache.set(cacheKey, contact);
    }

    if (!contact) {
      counts.no_contact++;
      console.log('  ' + row.id + ' → no contact');
      continue;
    }
    const masterId = extractMasterId(contact);
    if (!masterId) {
      counts.no_master_id++;
      console.log('  ' + row.id + ' → contact found but no "order id" attribute');
      continue;
    }

    // Also backfill intercom_contact_id if it was missing — we have it
    // now from the search result, no reason to leave it NULL.
    const patch = { bask_master_id: masterId };
    if (!row.intercom_contact_id && contact.id) {
      patch.intercom_contact_id = contact.id;
    }

    const ok = await patchRow(row.id, patch);
    if (ok) {
      counts.updated++;
      console.log('  ' + row.id + ' → ' + masterId + (DRY_RUN ? ' (dry-run, not written)' : ''));
    } else {
      counts.errors++;
    }
  }

  console.log('done:', counts);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(2);
});
