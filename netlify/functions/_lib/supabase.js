// _lib/supabase.js
//
// Environment plumbing and HTTP header builders for talking to
// Supabase from inside Netlify Functions. Extracted from kb.js
// (v0.4.0) so route handlers don't each carry their own copies of
// the env-var lookups and header construction.
//
// Two header modes:
//   - readHeaders(token): user-JWT auth. RLS applies (and the
//     migrations enable RLS without SELECT policies on most tenant
//     tables, so user-JWT reads typically return [] — keep this in
//     mind if a query mysteriously comes back empty).
//   - writeHeaders(): service-key auth. Bypasses RLS. EVERY caller
//     that uses writeHeaders MUST add a tenant-scoping `company_id=`
//     filter explicitly — that's the keystone of the
//     RLS-independent read pattern across this codebase.
//
// Service key fallback: if SUPABASE_SERVICE_KEY isn't set, we fall
// back to the anon key for writeHeaders. That fallback only works
// for tables without RLS or where the anon role has the right
// policies — in our setup that means writes will silently fail or
// produce empty reads. The fallback is here for local dev
// scenarios; production environments must have SUPABASE_SERVICE_KEY.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function readHeaders(token) {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": "Bearer " + (token || SUPABASE_ANON_KEY),
  };
}

function writeHeaders() {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  return {
    "Content-Type": "application/json",
    "apikey": key,
    "Authorization": "Bearer " + key,
    "Prefer": "return=representation",
  };
}

// JSON response helper. Body can be an object (will be stringified)
// or a pre-stringified string (e.g. forwarded from a fetch().text()
// without round-tripping through parse → stringify). Used by every
// route in this codebase.
const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

// Common shorthand for "is Supabase configured?" — used by the
// top-level handler to fail fast if env vars are missing.
function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_KEY,
  readHeaders,
  writeHeaders,
  json,
  isConfigured,
};
