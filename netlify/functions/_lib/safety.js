// _lib/safety.js
//
// Pure runtime safety gates. NO IO. Each export is a small predicate
// that other modules can consult before doing something with patient-
// or tenant-facing blast radius. Centralizing here means the same
// gate applies to every channel module that ever needs it — adding
// a new channel adapter automatically inherits the same kill-switch.
//
// The current gate is single-purpose: outbound-live-mode. Every
// patient-reply dispatch path (intercom, healthie, bask, email,
// future channels) consults `isOutboundLiveMode()` BEFORE making a
// network call. Default-off means a Netlify deploy with no env-var
// configured CAN'T accidentally send to a live patient — you have
// to consciously flip `OUTBOUND_LIVE_MODE=true` in the environment.
//
// To go live: set `OUTBOUND_LIVE_MODE=true` in Netlify env vars and
// redeploy. To kill-switch back to sandbox: unset (or set to any
// other value) and redeploy. The gate is binary — no per-channel,
// per-tenant, per-recipient nuance for v1. If/when we need finer
// granularity (e.g., "sandbox for tenant X only"), this module is
// where that logic lands.

// True only when OUTBOUND_LIVE_MODE is the literal string "true".
// Anything else — unset, "false", "1", "yes", typos — returns false.
// Conservative: requires explicit affirmative opt-in.
function isOutboundLiveMode() {
  return process.env.OUTBOUND_LIVE_MODE === 'true';
}

module.exports = {
  isOutboundLiveMode,
};
