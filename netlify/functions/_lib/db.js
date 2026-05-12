// _lib/db.js
//
// Data-access wrappers for tenant-scoped Supabase queries.
// Extracted from kb.js (v0.4.0) so URL construction and tenant
// scoping live in one place. Every fetch in the codebase that
// goes through these helpers gets the tenant filter for free —
// no risk of forgetting `company_id=eq.<theirs>` on a new endpoint.
//
// The pattern: each function takes the verified user's
// callerCompanyId (and user.id as a fallback for legacy rows
// where company_id is null) and produces the WHERE clause that
// constrains the query to that tenant.
//
// All functions return parsed JSON or null. Errors are logged but
// not thrown — callers decide how to handle null (404, 500, etc.).
//
// Note: this module deliberately stops short of being a full ORM.
// It only wraps queries that are used by more than one route or
// where the tenant filter would otherwise be hand-rolled in
// several places.

const { SUPABASE_URL, writeHeaders } = require("./supabase");

// Build the tenant clause prefix used across query_history /
// review_requests fetches. Returns a string like
// "&company_id=eq.<id>" or "&user_id=eq.<id>" (legacy fallback).
// Empty string if neither is available — caller decides if that's
// acceptable.
function tenantClause(companyId, userId) {
  if (companyId) return `&company_id=eq.${encodeURIComponent(companyId)}`;
  if (userId) return `&user_id=eq.${encodeURIComponent(userId)}`;
  return "";
}

// Fetch one query_history row by id, tenant-scoped. Used by the
// role gates to read the row before deciding whether to allow the
// action. Returns the row or null if not found in caller's tenant.
//
// Caller should treat null as 404, not "row is non-clinical."
async function fetchRowInTenant(rowId, companyId, userId) {
  if (!rowId) return null;
  try {
    const tc = tenantClause(companyId, userId);
    const url = `${SUPABASE_URL}/rest/v1/query_history?id=eq.${encodeURIComponent(rowId)}${tc}`
      + `&select=id,clinical_category,clinical_routing_level,non_clinical_flag,non_clinical_items,escalated_to_clinical,company_id&limit=1`;
    const r = await fetch(url, { headers: writeHeaders() });
    const arr = await r.json();
    return Array.isArray(arr) && arr[0] ? arr[0] : null;
  } catch (e) {
    console.error("db.fetchRowInTenant:", e.message);
    return null;
  }
}

// Fetch the originating triage for a review_request. Used by the
// /reviews resolve role gate to determine if the originating
// triage is clinical-tier.
async function fetchOriginTriage(triageId, companyId, userId) {
  return fetchRowInTenant(triageId, companyId, userId);
}

// Append a row to public.audit_log. Best-effort — never throws.
// Audit failures must not block real operations.
async function writeAuditLog(entry) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/audit_log", {
      method: "POST",
      headers: { ...writeHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error("db.writeAuditLog:", e.message);
  }
}

// Generic tenant-scoped DELETE. Returns the parsed response body
// and the raw HTTP status. Caller decides how to interpret an
// empty array result (typically 404 — row not in tenant).
async function tenantScopedDelete(table, rowId, companyId, userId) {
  const tc = tenantClause(companyId, userId);
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(rowId)}${tc}`;
  const r = await fetch(url, { method: "DELETE", headers: writeHeaders() });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, body: parsed, text };
}

// Generic tenant-scoped PATCH. Returns the parsed response body
// and the raw HTTP status. Caller decides how to interpret an
// empty array result (typically 404 — row not in tenant).
async function tenantScopedPatch(table, rowId, patch, companyId, userId) {
  const tc = tenantClause(companyId, userId);
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(rowId)}${tc}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: writeHeaders(),
    body: JSON.stringify(patch),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, body: parsed, text };
}

module.exports = {
  tenantClause,
  fetchRowInTenant,
  fetchOriginTriage,
  writeAuditLog,
  tenantScopedDelete,
  tenantScopedPatch,
};
