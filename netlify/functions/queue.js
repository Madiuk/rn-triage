// Care Station — Queue / pull-tasking endpoints (Phase 3)
//
// THIN ROUTER. All handlers live in
// netlify/functions/_lib/routes/queue.js. This file only does:
//
//   1. Fail-fast env-var check
//   2. Substring-match dispatch by path
//   3. Top-level error catch
//
// Endpoints (paths are substring-matched in order; more-specific
// paths must be checked first):
//
//   POST /queue/pull      → queue.handlePull
//   POST /queue/retask    → queue.handleRetask
//   POST /queue/reassign  → queue.handleReassign
//   POST /queue/send      → queue.handleSend
//   GET  /queue/mine      → queue.handleMine
//
// Invocation paths:
//   - Direct: /.netlify/functions/queue/<action>
//   - Clean (via netlify.toml redirect): /queue/<action>
//
// See ROADMAP.md "Week 1 — Substrate" §1.2 for endpoint contracts
// and PLAN.md "Per-staff queue" for the protocol they enforce.

const { isConfigured, json } = require("./_lib/supabase");
const queueRoute = require("./_lib/routes/queue");

exports.handler = async function (event) {
  if (!isConfigured()) {
    return json(500, { error: "Supabase not configured." });
  }

  const path = event.path || "";

  try {
    if (path.includes("/queue/pull"))     return queueRoute.handlePull(event);
    if (path.includes("/queue/retask"))   return queueRoute.handleRetask(event);
    if (path.includes("/queue/reassign")) return queueRoute.handleReassign(event);
    if (path.includes("/queue/send"))     return queueRoute.handleSend(event);
    if (path.includes("/queue/mine"))     return queueRoute.handleMine(event);

    return json(404, { error: "Not found", path: path });
  } catch (err) {
    console.error("queue.handler:", err.message);
    return json(500, { error: err.message });
  }
};
