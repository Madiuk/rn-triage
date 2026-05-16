// _lib/log.js
//
// Minimal structured error logger. Emits one JSON line to stderr per
// call so future log processors (Netlify function logs today; Sentry,
// Datadog, or similar later) can grep, filter, and parse with a
// consistent shape.
//
// Usage:
//   const { logError } = require('./_lib/log');
//   logError('intercom.dupCheck', err);
//   logError('ingest.insertFailed', null, { status: 422, body: snip });
//
// Conventions:
//   - ctx: short dotted string identifying the call site
//     ('module.operation'), used as a grep key.
//   - err: an Error, an error-like object, or null.
//   - fields: optional plain JSON-serializable extras. CALLER MUST NOT
//     pass patient_message, draft_response, or any other PHI — there
//     is no automatic redaction. Keep fields to identifiers, status
//     codes, and short context strings.
//
// The helper is wrapped in try/catch so a faulty log call cannot
// break the request path. If it can't emit structured output, it
// falls back to a plain console.error with the original error.

function logError(ctx, err, fields) {
  try {
    const rec = {
      level: 'error',
      ts: new Date().toISOString(),
      ctx: String(ctx || 'unknown'),
    };
    if (err && typeof err === 'object') {
      if (err.message) rec.msg = String(err.message).slice(0, 500);
      if (err.code) rec.code = String(err.code);
      if (err.name) rec.name = String(err.name);
    } else if (err !== undefined && err !== null) {
      rec.msg = String(err).slice(0, 500);
    }
    if (fields && typeof fields === 'object') {
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        rec[k] = typeof v === 'string' ? v.slice(0, 500) : v;
      }
    }
    console.error(JSON.stringify(rec));
  } catch (_) {
    try { console.error('logError.fault:', String(err && err.message || err)); } catch (__) {}
  }
}

module.exports = { logError };
