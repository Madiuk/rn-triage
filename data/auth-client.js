// Shared Supabase-token client used by both SPAs (app.js, tasking.js).
//
// Owns:
//   * localStorage session read/write (key: 'relai_session')
//   * silent access-token refresh (in-flight de-dupe + sign-out latch)
//   * authFetch(): bearer-attaching fetch with one 401 retry after refresh
//
// Dependency: data/supa-config.js must load BEFORE this file so
// window.RELAI_SUPA is populated.
//
// Per-SPA wiring is via window.RELAI_AUTH.configure({...}):
//   * toast(msg, kind)  — optional; shown when the session dies
//   * onSessionDead()   — optional; called right before the redirect
//                         (app.js uses it to clear cached profile)
//   * loginUrl()        — optional; returns the URL to redirect to when
//                         the session can't be refreshed
//                         (default: '/login.html')
//
// Why this module exists: both SPAs used to inline the same ~90 lines
// of auth code. Fixes to refresh/401/sign-out had to ship twice (and
// drifted at least once already — see app.js v0.4.1 sign-out latch
// comment). One source of truth now.

(function () {
  'use strict';

  var SESSION_KEY = 'relai_session';

  var cfg = {
    toast: null,
    onSessionDead: null,
    loginUrl: function () { return '/login.html'; },
  };

  // Sign-out latch. When sign-out fires, this flag stays true for the
  // page lifetime so an in-flight refresh can't repopulate localStorage
  // after sign-out cleared it. See app.js v0.4.1 fix for the symptom
  // ("I have to click Sign Out twice").
  var isSigningOut = false;

  // Shared in-flight refresh promise. Parallel API calls that all see
  // 401 must share a single refresh attempt — otherwise refresh-token
  // rotation races and only the last write wins.
  var refreshInFlight = null;

  function configure(opts) {
    if (!opts) return;
    if (typeof opts.toast === 'function') cfg.toast = opts.toast;
    if (typeof opts.onSessionDead === 'function') cfg.onSessionDead = opts.onSessionDead;
    if (typeof opts.loginUrl === 'function') cfg.loginUrl = opts.loginUrl;
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function getToken() {
    var s = getSession();
    return s ? s.access_token : null;
  }
  function setSigningOut(v) {
    isSigningOut = !!v;
  }

  async function refreshSupabaseToken() {
    if (isSigningOut) return false;
    if (refreshInFlight) return refreshInFlight;
    var supa = window.RELAI_SUPA || {};
    refreshInFlight = (async function () {
      try {
        var session = getSession();
        if (!session || !session.refresh_token) return false;
        var r = await fetch(supa.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': supa.key },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!r.ok) {
          console.error('RELAI_AUTH.refreshSupabaseToken: status', r.status);
          return false;
        }
        var data = await r.json();
        if (!data || !data.access_token) return false;
        // Re-check the latch: sign-out may have fired while we were
        // awaiting the network call. Don't repopulate the cleared session.
        if (isSigningOut) return false;
        localStorage.setItem(SESSION_KEY, JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || session.refresh_token,
          timestamp: Date.now(),
        }));
        return true;
      } catch (e) {
        console.error('RELAI_AUTH.refreshSupabaseToken:', e.message);
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  // Bearer-token-attaching fetch with one refresh-then-retry on 401.
  async function authFetch(url, opts) {
    opts = opts || {};
    var baseHeaders = Object.assign({}, opts.headers || {});
    var doFetch = function (tok) {
      var hdrs = Object.assign({}, baseHeaders);
      if (tok) hdrs['Authorization'] = 'Bearer ' + tok;
      return fetch(url, Object.assign({}, opts, { headers: hdrs }));
    };

    var r = await doFetch(getToken());
    if (r.status !== 401) return r;

    var refreshed = await refreshSupabaseToken();
    if (refreshed) return await doFetch(getToken());

    // Refresh failed. If we had a session at all, it's dead — surface
    // it via toast (if registered), then run any cleanup and redirect.
    // Don't redirect synchronously — the caller's catch block needs to
    // run first.
    if (getSession()) {
      if (cfg.toast) {
        try { cfg.toast('Session expired — redirecting to login...', 'warn'); } catch (e) {}
      }
      setTimeout(function () {
        try {
          localStorage.removeItem(SESSION_KEY);
          if (cfg.onSessionDead) cfg.onSessionDead();
        } catch (e) { /* swallow — still redirect */ }
        window.location.href = cfg.loginUrl();
      }, 1500);
    }
    return r;
  }

  window.RELAI_AUTH = {
    configure: configure,
    getSession: getSession,
    getToken: getToken,
    setSigningOut: setSigningOut,
    refreshSupabaseToken: refreshSupabaseToken,
    authFetch: authFetch,
  };
})();
