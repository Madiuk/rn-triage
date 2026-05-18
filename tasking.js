/*
 * Care Station — Tasking Queue SPA (v0)
 *
 * The queue-first staff surface. Mirrors demo.js's interaction
 * patterns (queue table + side panel) but on real /queue/* endpoints
 * and real Supabase auth. Self-contained: no dependency on app.js
 * or its globals. Loads data/defaults.js for RELAI_DEFAULTS only.
 *
 * Auth flow:
 *   1. On load, check for relai_session in localStorage.
 *   2. If no session, redirect to /login.html?next=<current path>.
 *      This SPA is now the site default (formerly served at
 *      /tasking.html); '/' resolves here.
 *   3. With a session, call /auth/profile (auto-bootstraps super-user
 *      on first login). Paint the chip + apply profile UI.
 *   4. Load categories (/kb/categories) for the pull dropdown.
 *   5. Load own queue (/queue/mine) — shows tasks already claimed.
 *
 * Outbound safety: every /queue/send call goes through the existing
 * dispatchOutbound chokepoint, which is gated by OUTBOUND_LIVE_MODE.
 * In sandbox mode (default), Send writes the DB state transition but
 * no patient-facing network call fires. UI surfaces this via the
 * sandbox banner + "Sent (sandbox)" tag.
 */

(function () {
  'use strict';

  // ── Constants from data/defaults.js (loaded by tasking.html) ────────
  const DEFAULTS = (typeof RELAI_DEFAULTS !== 'undefined') ? RELAI_DEFAULTS : {};
  const SEVERITY_THRESHOLD = DEFAULTS.severityUrgencyThreshold || 7;
  const ROUTING_HUB_NAME   = DEFAULTS.routingHubCategory || 'Routing Hub';
  const APP_TITLES         = DEFAULTS.appTitles || ['MD', 'NP', 'DO', 'PA'];
  const BASK_ADMIN_URL_TEMPLATE =
    (DEFAULTS.externalSystems && DEFAULTS.externalSystems.bask
      && DEFAULTS.externalSystems.bask.adminPatientUrlTemplate) || '';
  const BASK_ORDER_URL_TEMPLATE =
    (DEFAULTS.externalSystems && DEFAULTS.externalSystems.bask
      && DEFAULTS.externalSystems.bask.adminOrderUrlTemplate) || '';
  const HEALTHIE_PATIENT_URL_TEMPLATE =
    (DEFAULTS.externalSystems && DEFAULTS.externalSystems.healthie
      && DEFAULTS.externalSystems.healthie.adminPatientUrlTemplate) || '';

  // ── Supabase config (same project as app.js / login.html) ───────────
  // Auth (session, token, refresh, authFetch) lives in
  // data/auth-client.js, loaded before this script via index.html.
  // The state object below carries SPA-specific UI state only.

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    user: null,           // Supabase auth user
    profile: null,        // /auth/profile response
    categories: [],       // [{ category_name, is_clinical }, ...]
    queue: [],            // current pending queue (own tasks)
    selectedPullCategories: new Set(),
    openTaskId: null,
    activeView: 'queue',  // 'queue' | 'detail' | 'events' | 'staff'
    staffList: [],        // /auth/staff response (super-user only)
    // Local-session map of staged follow-ups per parent task id. The
    // server already knows about the rows (status='pending_parent');
    // this is just the chip counter the originator sees.
    followupsStagedByParent: {},
  };

  // ── Display helpers ────────────────────────────────────────────────

  // Map DB status values to user-friendly labels. The DB enum stays
  // exactly as documented in PLAN.md (pending / triaged / reviewed /
  // patient_replied / sent / closed / completed) — these are just the
  // strings the SPA shows the user. "Triaged" sounded misleading in
  // testing (it suggested someone had ACTED on the row when really
  // the AI had just classified it); "Awaiting reply" is closer to
  // what a clinician would expect to see.
  const STATUS_LABELS = {
    'pending':         'Pending triage',
    'triaged':         'Awaiting reply',
    'reviewed':        'Needs human review',
    'patient_replied': 'Patient followed up',
    'sent':            'Sent',
    'closed':          'Closed',
    'completed':       'Completed',
  };
  function displayStatus(s) {
    return STATUS_LABELS[s] || (s || '—');
  }

  // ─────────────────────────────────────────────────────────────────
  // Auth helpers — thin aliases over data/auth-client.js. The shared
  // module owns the session/refresh/401-retry flow; this SPA configures
  // its toast hook and the post-redirect URL (?next= so we land back
  // on the same page after re-auth).
  // ─────────────────────────────────────────────────────────────────

  const getSession = window.RELAI_AUTH.getSession;
  const getToken   = window.RELAI_AUTH.getToken;
  const refreshSupabaseToken = window.RELAI_AUTH.refreshSupabaseToken;
  const authFetch  = window.RELAI_AUTH.authFetch;

  window.RELAI_AUTH.configure({
    toast: function (m, k) { try { toast(m, k); } catch (e) {} },
    loginUrl: function () {
      return '/login.html?next=' + encodeURIComponent(window.location.pathname);
    },
  });

  // Single-attempt JSON helper. Throws on network failure (with
  // err.isNetworkError = true) or non-2xx HTTP. Used by api() below.
  async function apiOnce(url, opts) {
    let r;
    try {
      r = await authFetch(url, opts);
    } catch (e) {
      // fetch() rejected before any response arrived — TypeError
      // "Failed to fetch", CORS rejection, DNS failure, timeout, etc.
      // Surface as a labeled error so the wrapper can decide whether
      // to retry, and so call sites can show a friendly message
      // instead of the raw browser string.
      const wrapped = new Error('Network issue — please try again.');
      wrapped.isNetworkError = true;
      wrapped.cause = e;
      throw wrapped;
    }
    let body = null;
    try { body = await r.json(); } catch (e) { /* allow text responses */ }
    if (!r.ok) {
      const err = new Error('API ' + r.status + (body && body.error ? ': ' + body.error : ''));
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // Retry-safe request helper. Auto-retries once on a transient
  // network failure when the request is safe to repeat:
  //   * GET / HEAD — idempotent by HTTP semantics
  //   * POST / PATCH / DELETE that includes an idempotency_key in
  //     the JSON body — server dedupes on (company_id, key)
  // Anything else (POST without a key) gets the friendly error but
  // no auto-retry, to avoid silently creating duplicates.
  async function api(url, opts) {
    try {
      return await apiOnce(url, opts);
    } catch (e) {
      if (e && e.isNetworkError && canRetryRequest(opts)) {
        await new Promise(r => setTimeout(r, 250));
        return await apiOnce(url, opts);
      }
      throw e;
    }
  }

  function canRetryRequest(opts) {
    const method = (opts && opts.method && opts.method.toUpperCase()) || 'GET';
    if (method === 'GET' || method === 'HEAD') return true;
    const body = opts && opts.body;
    return typeof body === 'string' && body.indexOf('"idempotency_key"') !== -1;
  }

  // Module-scoped UUID for the in-flight spawn-followup submission.
  // Generated lazily on the first confirmSpawnFollowup attempt; reused
  // across retries of the same submission; cleared on success or when
  // the modal is reopened for a new submission. Pairs with the
  // idempotency_key column added in migration 0032.
  let pendingFollowupKey = null;
  function makeIdempotencyKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // ─────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────

  async function init() {
    // 0. Hash-returning auth flow handler. Supabase emails (invite,
    // recovery, etc.) drop the user back at a redirect URL with a
    // session JWT in the URL hash:
    //   #access_token=...&refresh_token=...&type=<recovery|invite|magiclink|signup>
    //
    // Phase 4 retired magic-link sign-in entirely. Only recovery and
    // invite tokens are still recognized; everything else (magiclink,
    // signup, no type) is bounced to /login.html with a banner. The
    // alternative — silently accepting the session — is exactly the
    // bug that hit Brad 2026-05-17 (a recovery token logged him in
    // without ever prompting for a new password).
    //
    //   recovery  → /reset-password.html (with hash preserved)
    //   invite    → /accept-invite.html  (with hash preserved)
    //   anything  → /login.html?reason=magiclink_disabled (no session)
    //   else
    const h = window.location.hash;
    if (h && h.indexOf('access_token') !== -1) {
      try {
        const params = new URLSearchParams(h.replace('#', ''));
        const token = params.get('access_token');
        const type  = params.get('type') || '';
        if (token && type === 'recovery') {
          window.location.replace('/reset-password.html' + h);
          return;
        }
        if (token && type === 'invite') {
          window.location.replace('/accept-invite.html' + h);
          return;
        }
        if (token) {
          // Magic-link / signup / no-type: bounce to login with a
          // reason flag. login.html surfaces the banner explaining
          // that magic-link sign-in is no longer supported. No
          // session is saved.
          window.location.replace('/login.html?reason=magiclink_disabled');
          return;
        }
      } catch (e) {
        console.error('tasking.parseAuthHash:', e.message);
      }
    }

    // 1. Session gate. No session → bounce to login with return URL.
    if (!getSession()) {
      window.location.replace('/login.html?next=' + encodeURIComponent(window.location.pathname));
      return;
    }

    // 2. Load profile. /auth/profile auto-promotes the first user in
    // a tenant to super-user (idempotent), so this is also the path
    // that bootstraps Brad on a fresh deploy.
    //
    // The endpoint returns { user, profile } as a wrapper — unwrap
    // here so the rest of the SPA can read state.profile directly.
    // Without this unwrap, every downstream reader (chip painting,
    // pull-dropdown eligibility, etc.) got `undefined` for role and
    // title, and every category dropped to the 'never' eligibility
    // tier — observed by Brad 2026-05-17.
    try {
      const resp = await api('/.netlify/functions/auth/profile', { method: 'GET' });
      state.user = (resp && resp.user) || null;
      state.profile = (resp && resp.profile) || null;
      if (!state.profile) {
        toast('Profile not returned by /auth/profile.', 'error');
        return;
      }
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem('relai_session');
        window.location.replace('/login.html?next=' + encodeURIComponent(window.location.pathname));
        return;
      }
      toast('Could not load profile: ' + e.message, 'error');
      return;
    }
    applyProfileUI();

    // 3. Load categories for the pull dropdown.
    try {
      state.categories = await api('/.netlify/functions/kb/categories', { method: 'GET' });
      if (!Array.isArray(state.categories)) state.categories = [];
    } catch (e) {
      console.warn('categories load failed:', e.message);
      state.categories = [];
    }

    // Augment with Routing Hub if not already seeded in
    // category_metadata. The endpoint /queue/pull accepts it either
    // way (the route module always seeds the routing hub from
    // defaults); the UI just needs an entry so the user can tick it.
    if (!state.categories.some(c => c.category_name === ROUTING_HUB_NAME)) {
      state.categories.push({
        category_name: ROUTING_HUB_NAME,
        is_clinical: false,
        is_active: true,
        display_order: 999,
      });
    }
    renderPullDropdown();

    // 4. Load own queue.
    await refreshQueue();

    // 5. Wire hash routing AFTER the initial queue load so a deep
    // link (#task/<id>) finds the task in state.queue.
    window.addEventListener('hashchange', handleHashChange);
    // Apply current hash (in case the user landed directly on
    // #task/<id> or reloaded with a hash set).
    if (window.location.hash) {
      handleHashChange();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Profile UI
  // ─────────────────────────────────────────────────────────────────

  function applyProfileUI() {
    const p = state.profile || {};
    const name = p.full_name || (state.user && state.user.email) || 'Staff';
    const initials = nameToInitials(name);
    const title = p.title || (p.role === 'Clinical' ? 'RN' : 'CSR');

    setText('staffChipName', name);
    setText('staffDeptBadge', title);
    setText('chipAvatar', initials);

    // Profile panel
    setText('profileName', name);
    setText('profileEmail', p.email || '');
    setText('profileRole', (p.role || 'Staff') + (title ? ' · ' + title : ''));
    setText('profileAvatar', initials);
    setText('profileCompany', p.company_name || p.company_id || '—');

    // Super-user-only nav buttons live inside the profile pop-out card.
    // Server-side gate (in admin-events.js and auth.js) is the real
    // boundary; this is just chrome.
    const eventsLink = document.getElementById('eventsLinkBtn');
    if (eventsLink) {
      eventsLink.style.display = p.is_super_user ? '' : 'none';
    }
    const staffLink = document.getElementById('staffLinkBtn');
    if (staffLink) {
      staffLink.style.display = p.is_super_user ? '' : 'none';
    }

    // Manual paste (legacy) is super-user-only. The legacy SPA at
    // /manual.html stays reachable by direct URL, but other staff
    // never see the button in their profile panel — the goal is the
    // tasking queue replaces it for everyone except the operator who
    // occasionally needs ad-hoc query access.
    const manualLink = document.getElementById('manualLinkBtn');
    if (manualLink) {
      manualLink.style.display = p.is_super_user ? '' : 'none';
    }
  }

  function nameToInitials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();
  }

  // ─────────────────────────────────────────────────────────────────
  // Queue load + render
  // ─────────────────────────────────────────────────────────────────

  async function refreshQueue() {
    try {
      const resp = await api('/queue/mine', { method: 'GET' });
      state.queue = (resp && Array.isArray(resp.tasks)) ? resp.tasks : [];
      renderQueue();
    } catch (e) {
      toast('Could not load queue: ' + e.message, 'error');
      state.queue = [];
      renderQueue();
    }
  }

  function renderQueue() {
    const tbody = document.getElementById('taskTableBody');
    const emptyEl = document.getElementById('emptyState');
    const tasks = state.queue;

    if (tasks.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      tbody.innerHTML = '';
      tasks.forEach(t => tbody.appendChild(renderTaskRow(t)));
    }

    renderQueueStats(tasks);
    updatePullButtonState(tasks);
  }

  function renderQueueStats(tasks) {
    const severe = tasks.filter(t => (t.urgency_score || 0) >= SEVERITY_THRESHOLD).length;
    const due = tasks.filter(t => t.due_state).length;
    const total = tasks.length;
    const stats = document.getElementById('queueStats');
    stats.innerHTML =
      '<div class="queue-stat normal"><div class="queue-stat-num">' + total + '</div><div class="queue-stat-label">In queue</div></div>'
      + (severe > 0 ? '<div class="queue-stat severe"><div class="queue-stat-num">' + severe + '</div><div class="queue-stat-label">Severe</div></div>' : '')
      + (due > 0 ? '<div class="queue-stat due"><div class="queue-stat-num">' + due + '</div><div class="queue-stat-label">Due</div></div>' : '');
  }

  function updatePullButtonState(tasks) {
    const btn = document.getElementById('pullBtn');
    const cap = document.getElementById('pullBtnCap');
    if (!btn || !cap) return;
    if (tasks.length === 0) {
      btn.disabled = false;
      cap.textContent = '(up to 5)';
      btn.title = 'Pull up to 5 tasks into your queue';
    } else {
      btn.disabled = true;
      const dueCount = tasks.filter(t => t.due_state).length;
      cap.textContent = dueCount >= 5
        ? '(queue locked — clear a Due task first)'
        : '(finish current queue first)';
      btn.title = btn.title || cap.textContent;
    }
  }

  function renderTaskRow(t) {
    const tr = document.createElement('tr');
    tr.dataset.taskId = t.id;
    tr.innerHTML =
      '<td>' + renderSeverityBadge(t) + '</td>'
      + '<td>' + renderChannelChip(t.source_channel) + '</td>'
      + '<td class="time-cell">' + formatTime(t.created_at) + '</td>'
      + '<td>' + renderPatientCell(t) + '</td>'
      + '<td>' + renderCategoryTag(t.clinical_category) + '</td>'
      + '<td class="summary-cell">' + escapeHtml(summarize(t)) + '</td>';
    tr.addEventListener('click', () => {
      // Navigate via hash so back/forward + reload preserve the
      // current task view. The hash listener handles the actual
      // render swap (showDetailView).
      window.location.hash = '#task/' + t.id;
    });
    return tr;
  }

  function renderSeverityBadge(t) {
    const score = t.urgency_score || 0;
    let cls, label;
    if (score >= SEVERITY_THRESHOLD) { cls = 'severe'; label = 'Severe'; }
    else if (t.due_state) { cls = 'due'; label = 'Due'; }
    else if ((t.urgency_original || '') === 'urgent') { cls = 'urgent'; label = 'Urgent'; }
    else if ((t.urgency_original || '') === 'same-day') { cls = 'urgent'; label = 'Same-day'; }
    else { cls = 'normal'; label = 'Routine'; }
    return '<span class="severity-badge ' + cls + '"><span class="sev-dot"></span>' + label + '</span>';
  }

  function renderChannelChip(channel) {
    const ch = (channel || 'manual').toLowerCase();
    const sym = {
      intercom: 'IC', healthie: 'HE', bask: 'BA',
      email: '@', manual: 'MP', api: 'API',
    }[ch] || '?';
    return '<span class="channel-chip ' + ch + '" title="' + escapeHtml(ch) + '">' + sym + '</span>';
  }

  function renderPatientCell(t) {
    // Prefer the real patient name + email captured from the Intercom
    // payload (migration 0029). For rows that pre-date the capture or
    // come from channels without identity (manual paste), show the
    // name fallback only — the upstream external_id (e.g. the
    // Intercom conversation id) is intentionally NOT surfaced to
    // staff; it's an internal channel reference, not a patient
    // identifier.
    const name = t.patient_name || 'Unknown patient';
    const sub  = t.patient_email || '';
    const icon = renderStatusIcon(t);
    return '<div class="patient-cell">'
      + '<span class="patient-name">' + escapeHtml(name) + icon + '</span>'
      + (sub ? '<span class="patient-id">' + escapeHtml(sub) + '</span>' : '')
      + '</div>';
  }

  // Small status icon shown inline next to the patient name when the
  // row is in a non-default status. The dedicated Status column was
  // removed 2026-05-17 (most rows were 'triaged' → "Awaiting reply",
  // which made the column noisy) but the operationally meaningful
  // states still need queue-glance visibility:
  //   reviewed         → AI escalated, treat as urgent triage
  //   patient_replied  → patient sent more, scroll to bottom of thread
  //   pending          → AI hasn't classified yet (rare / transient)
  function renderStatusIcon(t) {
    const s = t.status || '';
    if (s === '' || s === 'triaged') return '';
    let glyph = '', cls = '', title = '';
    if (s === 'reviewed')        { glyph = '&#9888;';  cls = 'reviewed';        title = 'Needs human review'; }
    else if (s === 'patient_replied') { glyph = '&#9166;'; cls = 'patient-replied'; title = 'Patient followed up'; }
    else if (s === 'pending')    { glyph = '&#8987;';  cls = 'pending';         title = 'Pending triage'; }
    else                          { glyph = '&#8226;';  cls = '';                title = displayStatus(s); }
    return ' <span class="patient-status-icon ' + cls + '" title="' + escapeHtml(title) + '">' + glyph + '</span>';
  }

  function renderCategoryTag(category) {
    if (!category) return '<span class="category-tag">—</span>';
    const isRouting = (category === ROUTING_HUB_NAME);
    const clinical = (DEFAULTS.categories || {})[category];
    const isClinical = clinical && clinical.requires_clinical_authorization && !isRouting;
    let cls = '';
    if (isRouting) cls = ' routing-hub';
    else if (isClinical) cls = ' clinical';
    return '<span class="category-tag' + cls + '">' + escapeHtml(category) + '</span>';
  }

  function renderStatusBadge(t) {
    const s = t.status || 'pending';
    let badge = '<span class="status-badge ' + s + '">' + escapeHtml(displayStatus(s)) + '</span>';
    if (t.due_state) badge += '<span class="due-flag">DUE</span>';
    return badge;
  }

  function summarize(t) {
    // First non-empty line of the patient message, truncated.
    const msg = (t.patient_message || '').trim();
    if (!msg) return '(empty message)';
    const firstLine = msg.split('\n').find(l => l.trim().length > 0) || '';
    if (firstLine.length <= 100) return firstLine;
    return firstLine.slice(0, 97) + '...';
  }

  // ─────────────────────────────────────────────────────────────────
  // Pull dropdown
  // ─────────────────────────────────────────────────────────────────

  function renderPullDropdown() {
    const body = document.getElementById('pullDropdownBody');
    if (!body) return;
    body.innerHTML = '';

    const profile = state.profile || {};
    const isApp = profile.title && APP_TITLES.indexOf(profile.title) !== -1;
    const role = profile.role;

    // Pre-check from profile.category_preferences (array). Falls back
    // to "no preselection."
    const prefs = new Set(Array.isArray(profile.category_preferences) ? profile.category_preferences : []);
    state.selectedPullCategories = new Set();

    // Sort: clinical first, then non-clinical, alphabetical within each.
    const sorted = state.categories.slice().sort((a, b) => {
      const ca = a.is_clinical ? 0 : 1;
      const cb = b.is_clinical ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (a.category_name || '').localeCompare(b.category_name || '');
    });

    sorted.forEach(cat => {
      const elig = computeEligibility(role, isApp, cat);
      const wrapper = document.createElement('label');
      wrapper.className = 'pull-category-option' + (elig === 'never' ? ' disabled' : '');
      const checked = prefs.has(cat.category_name) && elig !== 'never';
      if (checked) state.selectedPullCategories.add(cat.category_name);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.disabled = (elig === 'never');
      input.dataset.cat = cat.category_name;
      input.addEventListener('change', () => {
        if (input.checked) state.selectedPullCategories.add(cat.category_name);
        else state.selectedPullCategories.delete(cat.category_name);
        updatePullConfirmState();
      });
      wrapper.appendChild(input);
      const name = document.createElement('span');
      name.className = 'pull-category-name';
      name.textContent = cat.category_name;
      wrapper.appendChild(name);

      let tagHtml = '';
      if (elig === 'idle_only') {
        tagHtml = '<span class="pull-category-tag idle" title="Available when your in-scope pool is empty">Idle</span>';
      } else if (elig === 'never') {
        tagHtml = '<span class="pull-category-tag disabled-tag">Not eligible</span>';
      } else if (cat.is_clinical) {
        tagHtml = '<span class="pull-category-tag" style="background:#dbeafe;color:#1e40af">Clinical</span>';
      } else if (cat.category_name === ROUTING_HUB_NAME) {
        tagHtml = '<span class="pull-category-tag idle">Routing Hub</span>';
      }
      wrapper.insertAdjacentHTML('beforeend', tagHtml);

      body.appendChild(wrapper);
    });
    updatePullConfirmState();
  }

  function computeEligibility(role, isApp, cat) {
    // Mirror server-side categoryEligibility (permissions.js).
    if (isApp) {
      return cat.is_clinical ? 'always' : 'never';
    }
    if (cat.category_name === ROUTING_HUB_NAME) {
      if (role === 'Non-Clinical') return 'always';
      if (role === 'Clinical') return 'idle_only';
      return 'never';
    }
    if (cat.is_clinical) {
      return (role === 'Clinical') ? 'always' : 'never';
    }
    if (role === 'Non-Clinical') return 'always';
    if (role === 'Clinical') return 'idle_only';
    return 'never';
  }

  function updatePullConfirmState() {
    const btn = document.getElementById('pullDropdownConfirm');
    if (!btn) return;
    btn.disabled = state.selectedPullCategories.size === 0;
  }

  window.togglePullDropdown = function () {
    const d = document.getElementById('pullDropdown');
    d.classList.toggle('active');
    d.setAttribute('aria-hidden', d.classList.contains('active') ? 'false' : 'true');
  };

  // Select all categories the caller is eligible for (i.e., the
  // checkboxes that aren't disabled). Quick-win for the no-pre-check
  // problem when profile.category_preferences isn't yet implemented.
  window.selectAllEligible = function () {
    const body = document.getElementById('pullDropdownBody');
    if (!body) return;
    const inputs = body.querySelectorAll('input[type="checkbox"]');
    inputs.forEach(input => {
      if (!input.disabled) {
        input.checked = true;
        state.selectedPullCategories.add(input.dataset.cat);
      }
    });
    updatePullConfirmState();
  };

  window.selectNone = function () {
    const body = document.getElementById('pullDropdownBody');
    if (!body) return;
    const inputs = body.querySelectorAll('input[type="checkbox"]');
    inputs.forEach(input => {
      input.checked = false;
    });
    state.selectedPullCategories.clear();
    updatePullConfirmState();
  };

  window.confirmPull = async function () {
    const btn = document.getElementById('pullDropdownConfirm');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Pulling...';
    try {
      const resp = await api('/queue/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: Array.from(state.selectedPullCategories) }),
      });
      const tasks = (resp && resp.tasks) || [];
      const idleUnlock = !!(resp && resp.idle_unlock_used);
      if (tasks.length === 0) {
        toast('No tasks available in the categories you selected.', 'warn');
      } else {
        toast(
          'Pulled ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's')
          + (idleUnlock ? ' (idle-unlock fallback)' : ''),
          'success'
        );
      }
      togglePullDropdown();
      await refreshQueue();
    } catch (e) {
      if (e.status === 409 && e.body) {
        const reason = e.body.reason || 'conflict';
        const msg = e.body.error || 'Queue is locked.';
        toast(msg, 'warn');
      } else {
        toast('Pull failed: ' + e.message, 'error');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Pull';
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // View switching (queue ↔ detail)
  // ─────────────────────────────────────────────────────────────────
  //
  // Two views in main.main-content:
  //   - #queueView  — the list of pulled tasks (default)
  //   - #detailView — full-page task detail
  //
  // Navigation is hash-driven so browser back/forward + reload work:
  //   #queue (or no hash)  → queue view
  //   #task/<id>            → detail view for that task
  //
  // The hash listener (installed in init()) is the single dispatch
  // point. Functions that want to navigate just set the hash; they
  // don't render directly.

  function showQueueView() {
    state.activeView = 'queue';
    state.openTaskId = null;
    document.getElementById('queueView').style.display = '';
    document.getElementById('detailView').style.display = 'none';
    const ev = document.getElementById('eventsView');
    if (ev) ev.style.display = 'none';
    const sv = document.getElementById('staffView');
    if (sv) sv.style.display = 'none';
    setActiveTab('queueTabBtn');
    // Refresh in case the queue mutated while we were in detail
    // (e.g., a retask/send + back).
    refreshQueue();
  }

  async function showDetailView(taskId) {
    let t = state.queue.find(x => x.id === taskId);
    let viewerOwnsTask = true;  // local queue means the row was pulled by us

    // Fallback for deep-link navigation when the task isn't in our
    // local queue cache. Hits /queue/peek which is gated server-side
    // to "super-user OR task owner" — non-owners who aren't super-users
    // get 403 here and we fall back to the existing toast.
    if (!t) {
      try {
        const resp = await api(
          '/queue/peek?id=' + encodeURIComponent(taskId),
          { method: 'GET' }
        );
        if (resp && resp.task && resp.task.id) {
          t = resp.task;
          viewerOwnsTask = !!resp.viewer_owns_task;
        }
      } catch (e) {
        // 403 / 404 / network — handled by the catch-all below.
      }
    }

    if (!t) {
      toast('That task is no longer in your queue.', 'warn');
      window.location.hash = '#queue';
      return;
    }

    state.activeView = 'detail';
    state.openTaskId = taskId;
    state.viewerOwnsOpenTask = viewerOwnsTask;
    document.getElementById('queueView').style.display = 'none';
    document.getElementById('detailView').style.display = '';
    const ev = document.getElementById('eventsView');
    if (ev) ev.style.display = 'none';
    const sv = document.getElementById('staffView');
    if (sv) sv.style.display = 'none';
    setActiveTab('queueTabBtn');
    renderDetailView(t);
    const body = document.getElementById('detailViewBody');
    if (body) body.scrollTop = 0;
  }

  function showEventsView(subtab) {
    // Server-side gate is the real boundary; this prevents accidental
    // UI navigation by a non-super-user (e.g., via a shared link).
    if (!state.profile || !state.profile.is_super_user) {
      toast('Event Log is super-user only.', 'warn');
      window.location.hash = '#queue';
      return;
    }
    state.activeView = 'events';
    document.getElementById('queueView').style.display = 'none';
    document.getElementById('detailView').style.display = 'none';
    document.getElementById('eventsView').style.display = '';
    const sv = document.getElementById('staffView');
    if (sv) sv.style.display = 'none';
    setActiveTab('eventsTabBtn');
    state.eventsSubtab = subtab && ['inbound', 'reviews', 'errors', 'learning', 'conversations'].indexOf(subtab) >= 0
      ? subtab : 'inbound';
    // Visually mark the active sub-tab
    document.querySelectorAll('.events-subtab').forEach(b => {
      b.classList.toggle('active', b.dataset.subtab === state.eventsSubtab);
    });
    loadEvents(state.eventsSubtab);
  }

  // ─────────────────────────────────────────────────────────────────
  // Staff admin view (super-user only)
  // ─────────────────────────────────────────────────────────────────

  function showStaffView() {
    // Server-side gate on /auth/staff and /auth/invite is the real
    // boundary; this UI guard just keeps non-super-users out of an
    // empty/broken view if they manually navigate to #staff.
    if (!state.profile || !state.profile.is_super_user) {
      toast('Staff admin is super-user only.', 'warn');
      window.location.hash = '#queue';
      return;
    }
    state.activeView = 'staff';
    document.getElementById('queueView').style.display = 'none';
    document.getElementById('detailView').style.display = 'none';
    const ev = document.getElementById('eventsView');
    if (ev) ev.style.display = 'none';
    const sv = document.getElementById('staffView');
    if (sv) sv.style.display = '';
    setActiveTab('staffTabBtn');
    loadStaffList();
  }

  async function loadStaffList() {
    const tbody = document.getElementById('staffTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="loading-row">Loading…</td></tr>';
    try {
      const resp = await api('/.netlify/functions/auth/staff', { method: 'GET' });
      state.staffList = (resp && Array.isArray(resp.staff)) ? resp.staff : [];
      renderStaffList();
    } catch (e) {
      toast('Could not load staff: ' + e.message, 'error');
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="loading-row">Could not load.</td></tr>';
    }
  }

  function renderStaffList() {
    const tbody   = document.getElementById('staffTableBody');
    const emptyEl = document.getElementById('staffEmptyState');
    const table   = document.getElementById('staffTable');
    if (!tbody) return;

    const list = state.staffList || [];
    if (list.length === 0) {
      tbody.innerHTML = '';
      if (table)   table.style.display = 'none';
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (table)   table.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';
    tbody.innerHTML = '';
    list.forEach(s => tbody.appendChild(renderStaffRow(s)));
  }

  function renderStaffRow(s) {
    const tr = document.createElement('tr');
    tr.dataset.userId = s.id;
    const isPending = !s.accepted_at;
    const isSelf = !!(state.profile && state.profile.id === s.id);
    const callerIsSuperUser = !!(state.profile && state.profile.is_super_user);

    // Name cell — name display on top, editable prefix + suffix on
    // the row below. Edits save on blur (matches the legacy app.js
    // admin UI pattern); change-detect via initial value on the
    // element so unchanged blurs don't trigger a network round-trip.
    const nameCell = document.createElement('td');
    nameCell.className = 'staff-name-cell';
    nameCell.appendChild(buildStaffNameStack(s));
    tr.appendChild(nameCell);

    // Email — read-only (auth identity).
    const emailCell = document.createElement('td');
    emailCell.className = 'staff-email-cell';
    emailCell.textContent = s.email || '—';
    tr.appendChild(emailCell);

    // Role + privilege flags. Self can edit own role but never own
    // super-user flag (server enforces self_demotion_blocked too,
    // this just hides the checkbox so the path can't be tried).
    const roleCell = document.createElement('td');
    roleCell.appendChild(buildStaffRoleStack(s, isSelf, callerIsSuperUser));
    tr.appendChild(roleCell);

    // Status badge + resend-invite for pending rows.
    const statusCell = document.createElement('td');
    statusCell.appendChild(buildStaffStatusStack(s, isPending));
    tr.appendChild(statusCell);

    const invitedCell = document.createElement('td');
    invitedCell.className = 'staff-meta-cell';
    invitedCell.textContent = formatStaffDate(s.invited_at || s.created_at);
    tr.appendChild(invitedCell);

    const seenCell = document.createElement('td');
    seenCell.className = 'staff-meta-cell';
    seenCell.textContent = s.last_seen ? formatStaffDate(s.last_seen) : '—';
    tr.appendChild(seenCell);

    return tr;
  }

  // ── Staff row builders ─────────────────────────────────────────────

  function buildStaffNameStack(s) {
    const wrap = document.createElement('div');
    wrap.className = 'staff-name-stack';

    const display = document.createElement('div');
    display.className = 'staff-name-display';
    display.textContent = formatStaffName(s);
    wrap.appendChild(display);

    const controls = document.createElement('div');
    controls.className = 'staff-name-controls';

    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.className = 'staff-inline-input staff-inline-input-prefix';
    prefixInput.maxLength = 8;
    prefixInput.placeholder = 'Prefix';
    prefixInput.value = s.prefix || '';
    prefixInput.title = 'Prefix (≤8 chars), e.g. Dr.';
    prefixInput.addEventListener('blur', function () {
      const v = prefixInput.value.trim();
      const current = s.prefix || '';
      if (v === current) return;
      updateStaffMember(s.id, { prefix: v === '' ? null : v });
    });
    controls.appendChild(prefixInput);

    const suffixInput = document.createElement('input');
    suffixInput.type = 'text';
    suffixInput.className = 'staff-inline-input staff-inline-input-suffix';
    suffixInput.maxLength = 24;
    suffixInput.placeholder = 'Credential';
    suffixInput.value = s.suffix || s.title || '';
    suffixInput.title = 'Credential / suffix (≤24 chars), e.g. RN, MD, NP';
    suffixInput.addEventListener('blur', function () {
      const v = suffixInput.value.trim();
      const current = s.suffix || s.title || '';
      if (v === current) return;
      updateStaffMember(s.id, { suffix: v === '' ? null : v });
    });
    controls.appendChild(suffixInput);

    wrap.appendChild(controls);
    return wrap;
  }

  function buildStaffRoleStack(s, isSelf, callerIsSuperUser) {
    const wrap = document.createElement('div');
    wrap.className = 'staff-role-stack';

    const sel = document.createElement('select');
    sel.className = 'staff-inline-select';
    [
      { v: 'Clinical',     label: 'Clinical' },
      { v: 'Non-Clinical', label: 'Non-Clinical' },
    ].forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.label;
      if (s.role === o.v) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      updateStaffMember(s.id, { role: sel.value });
    });
    wrap.appendChild(sel);

    const flags = document.createElement('div');
    flags.className = 'staff-flag-row';

    const adminLabel = document.createElement('label');
    adminLabel.className = 'staff-flag-checkbox';
    const adminCb = document.createElement('input');
    adminCb.type = 'checkbox';
    adminCb.checked = !!s.is_admin;
    adminCb.addEventListener('change', function () {
      updateStaffMember(s.id, { is_admin: adminCb.checked });
    });
    adminLabel.appendChild(adminCb);
    adminLabel.appendChild(document.createTextNode(' Admin'));
    flags.appendChild(adminLabel);

    // Super-user toggle: only shown for super-user callers, and never
    // for the caller's own row (server enforces self_demotion_blocked
    // — this hides the checkbox so the path can't even be tried).
    if (callerIsSuperUser && !isSelf) {
      const suLabel = document.createElement('label');
      suLabel.className = 'staff-flag-checkbox';
      const suCb = document.createElement('input');
      suCb.type = 'checkbox';
      suCb.checked = !!s.is_super_user;
      suCb.addEventListener('change', function () {
        updateStaffMember(s.id, { is_super_user: suCb.checked });
      });
      suLabel.appendChild(suCb);
      suLabel.appendChild(document.createTextNode(' Super-user'));
      flags.appendChild(suLabel);
    } else if (s.is_super_user) {
      // Show a read-only chip for self/non-super viewers so the flag
      // remains visible (the user shouldn't think they aren't).
      const ro = document.createElement('span');
      ro.className = 'staff-flag-readonly';
      ro.textContent = 'Super-user';
      flags.appendChild(ro);
    }
    wrap.appendChild(flags);
    return wrap;
  }

  function buildStaffStatusStack(s, isPending) {
    const wrap = document.createElement('div');
    wrap.className = 'staff-status-stack';

    const badge = document.createElement('span');
    badge.className = 'staff-status-badge ' + (isPending ? 'pending' : 'active');
    badge.textContent = isPending ? 'Pending invite' : 'Active';
    wrap.appendChild(badge);

    if (isPending && s.email) {
      const resend = document.createElement('button');
      resend.type = 'button';
      resend.className = 'staff-resend-btn';
      resend.textContent = 'Resend invite';
      resend.addEventListener('click', function () { resendInvite(s.id, s.email); });
      wrap.appendChild(resend);
    }
    return wrap;
  }

  // ── Staff row actions ──────────────────────────────────────────────

  async function updateStaffMember(userId, patch) {
    if (!userId || !patch || Object.keys(patch).length === 0) return;
    try {
      await api('/.netlify/functions/kb/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'update_role', user_id: userId }, patch)),
      });
      toast('Updated', 'success');
      // Reload so flags that cascade (e.g., super-user → admin in
      // some flows) reflect immediately, matching the legacy
      // updateUserRole() pattern.
      await loadStaffList();
    } catch (e) {
      const msg = (e.body && e.body.error) || e.message || 'Update failed.';
      toast(msg, 'error');
    }
  }

  async function resendInvite(userId, email) {
    if (!userId) return;
    if (!window.confirm('Resend an invite email to ' + (email || 'this user') + '?')) return;
    try {
      await api('/.netlify/functions/auth/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      toast('Invite resent to ' + email, 'success');
    } catch (e) {
      const msg = (e.body && e.body.error) || e.message || 'Could not resend invite.';
      toast(msg, 'error');
    }
  }

  function formatStaffName(s) {
    const core = (s.first_name || s.last_name)
      ? [s.first_name, s.last_name].filter(Boolean).join(' ')
      : (s.full_name || '');
    let name = s.prefix ? (s.prefix + ' ' + core).trim() : core;
    if (!name) name = '—';
    if (s.suffix) name += ', ' + s.suffix;
    return name;
  }

  function formatStaffDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const diff = Date.now() - d.getTime();
    const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
    if (diff < min)     return 'just now';
    if (diff < hr)      return Math.floor(diff / min) + 'm ago';
    if (diff < day)     return Math.floor(diff / hr)  + 'h ago';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return d.toLocaleDateString();
  }

  async function submitInviteForm() {
    const email      = (document.getElementById('inviteEmail')     || {}).value || '';
    const first_name = (document.getElementById('inviteFirstName') || {}).value || '';
    const last_name  = (document.getElementById('inviteLastName')  || {}).value || '';
    const role       = (document.getElementById('inviteRole')      || {}).value || '';
    const prefix     = (document.getElementById('invitePrefix')    || {}).value || '';
    const suffix     = (document.getElementById('inviteSuffix')    || {}).value || '';

    // Client-side validation mirrors the server gates in auth.js so
    // the user gets immediate feedback instead of a round-trip 400.
    if (!email.trim() || !email.includes('@') || !email.includes('.')) {
      showInviteMsg('Enter a valid email.', 'err');
      const el = document.getElementById('inviteEmail'); if (el) el.focus();
      return;
    }
    if (!first_name.trim()) {
      showInviteMsg('First name is required.', 'err');
      const el = document.getElementById('inviteFirstName'); if (el) el.focus();
      return;
    }
    if (!last_name.trim()) {
      showInviteMsg('Last name is required.', 'err');
      const el = document.getElementById('inviteLastName'); if (el) el.focus();
      return;
    }
    if (!role) {
      showInviteMsg('Pick a role.', 'err');
      const el = document.getElementById('inviteRole'); if (el) el.focus();
      return;
    }

    const body = {
      email: email.trim(),
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      role,
    };
    if (prefix.trim()) body.prefix = prefix.trim();
    if (suffix.trim()) body.suffix = suffix.trim();

    const btn    = document.getElementById('inviteSubmitBtn');
    const btnTxt = document.getElementById('inviteSubmitTxt');
    if (btn)    btn.disabled = true;
    if (btnTxt) btnTxt.textContent = 'Sending…';
    showInviteMsg('', '');

    try {
      await api('/.netlify/functions/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      showInviteMsg('Invite sent to ' + body.email + '. They\'ll get an email with a link to finish setup.', 'ok');
      ['inviteEmail','inviteFirstName','inviteLastName','inviteRole','invitePrefix','inviteSuffix']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      await loadStaffList();
    } catch (e) {
      const errMsg = (e.body && e.body.error) || e.message || 'Could not send invite.';
      showInviteMsg(errMsg, 'err');
    } finally {
      if (btn)    btn.disabled = false;
      if (btnTxt) btnTxt.textContent = 'Send invite';
    }
  }

  function showInviteMsg(text, type) {
    const m = document.getElementById('inviteFormMsg');
    if (!m) return;
    m.textContent = text;
    m.className = 'staff-form-msg' + (type ? ' ' + type : '');
  }

  window.backToQueue = function () {
    window.location.hash = '#queue';
  };
  window.navigateToQueue = function () { window.location.hash = '#queue'; };
  window.navigateToEvents = function () { window.location.hash = '#events'; };
  window.navigateToStaff  = function () { window.location.hash = '#staff'; };
  window.switchEventsSubtab = function (subtab) {
    window.location.hash = '#events/' + subtab;
  };
  window.loadStaffList    = loadStaffList;
  window.submitInviteForm = submitInviteForm;

  function setActiveTab(activeId) {
    ['queueTabBtn', 'eventsTabBtn', 'staffTabBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === activeId);
    });
  }

  // Listen for hash changes (browser back/forward AND programmatic
  // hash writes from elsewhere in this file). Single dispatch.
  function handleHashChange() {
    const h = (window.location.hash || '').replace(/^#/, '');
    if (h.indexOf('task/') === 0) {
      const id = h.slice('task/'.length);
      showDetailView(id);
    } else if (h.indexOf('events') === 0) {
      // '#events' or '#events/<subtab>'
      const sub = h === 'events' ? 'inbound' : h.replace(/^events\/?/, '');
      showEventsView(sub || 'inbound');
    } else if (h === 'staff') {
      showStaffView();
    } else {
      showQueueView();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Detail view rendering
  // ─────────────────────────────────────────────────────────────────

  function renderDetailView(t) {
    const channel = (t.source_channel || 'manual');

    // ── Header (sticky strip) ────────────────────────────────────────
    // Patient name [+ email] · Status · Time · [spacer] · channel chip.
    // Category, pencil, and severity badge moved into the AI
    // classification section in the left column. The flex spacer
    // pushes the channel chip to the far right. patient_name and
    // patient_email come from migration 0029 (Intercom inserts +
    // backfill); fall back to an external_id slug when null.
    const patientLabel = t.patient_name
      || ('Patient ' + (t.external_id || t.id).slice(-12));
    const patientEmail = t.patient_email || '';
    const channelLabels = {
      intercom: 'Intercom', healthie: 'Healthie', bask: 'Bask',
      email: 'Email', manual: 'Manual', api: 'API',
    };
    const channelKey = channel.toLowerCase();
    const channelDisplay = channelLabels[channelKey]
      || (channel.charAt(0).toUpperCase() + channel.slice(1));

    // Audit-view badge: shown when the viewer is a super-user reading
    // a task they don't own (e.g., reached the page via a deep link
    // from the Conversations subtab, not via /queue/pull). The badge
    // is purely informational — action buttons are not currently
    // gated by ownership, but the back-end /queue/send and friends
    // will reject mutations from a non-owner regardless.
    const auditChip = (state.viewerOwnsOpenTask === false)
      ? '<span class="detail-header-chip detail-header-audit" title="You are viewing a task you have not pulled. Actions may be rejected.">Audit view</span>'
      : '';

    // Bask deep-link chips. The patient link rides on bask_patient_id
    // (mig 0034); the order link rides on bask_master_id (mig 0035).
    // Each chip renders only when both the row has the relevant id
    // AND the tenant has its URL template configured. encodeURIComponent
    // on the ids defends against URL-breaking characters if Bask
    // ever changes the format.
    const baskPatientHref = (t.bask_patient_id && BASK_ADMIN_URL_TEMPLATE)
      ? BASK_ADMIN_URL_TEMPLATE.replace('{patient_id}', encodeURIComponent(t.bask_patient_id))
      : '';
    const baskPatientChip = baskPatientHref
      ? '<a class="detail-header-chip detail-header-bask" '
        + 'href="' + escapeHtml(baskPatientHref) + '" '
        + 'target="_blank" rel="noopener noreferrer" '
        + 'title="Open this patient in Bask admin">'
        + 'Bask record &rarr;'
        + '</a>'
      : '';
    const baskOrderHref = (t.bask_master_id && BASK_ORDER_URL_TEMPLATE)
      ? BASK_ORDER_URL_TEMPLATE.replace('{master_id}', encodeURIComponent(t.bask_master_id))
      : '';
    const baskOrderChip = baskOrderHref
      ? '<a class="detail-header-chip detail-header-bask" '
        + 'href="' + escapeHtml(baskOrderHref) + '" '
        + 'target="_blank" rel="noopener noreferrer" '
        + 'title="Open the order/master record in Bask admin">'
        + 'Order page &rarr;'
        + '</a>'
      : '';
    const healthieHref = (t.healthie_patient_id && HEALTHIE_PATIENT_URL_TEMPLATE)
      ? HEALTHIE_PATIENT_URL_TEMPLATE.replace('{patient_id}', encodeURIComponent(t.healthie_patient_id))
      : '';
    const healthieChip = healthieHref
      ? '<a class="detail-header-chip detail-header-bask" '
        + 'href="' + escapeHtml(healthieHref) + '" '
        + 'target="_blank" rel="noopener noreferrer" '
        + 'title="Open this patient in Healthie">'
        + 'Healthie patient &rarr;'
        + '</a>'
      : '';
    document.getElementById('detailHeaderInfo').innerHTML =
        '<div class="detail-header-row">'
      +   '<span class="detail-header-title">' + escapeHtml(patientLabel) + '</span>'
      +   (patientEmail
            ? '<span class="detail-header-chip detail-header-email" title="' + escapeHtml(patientEmail) + '">'
              + escapeHtml(patientEmail) + '</span>'
            : '')
      +   auditChip
      +   baskPatientChip
      +   baskOrderChip
      +   healthieChip
      +   '<span class="detail-header-chip">' + renderStatusBadge(t) + '</span>'
      +   '<span class="detail-header-chip detail-header-time" title="' + escapeHtml(formatDateTime(t.created_at)) + '">' + escapeHtml(formatTime(t.created_at)) + '</span>'
      +   '<span class="detail-header-spacer"></span>'
      +   '<span class="detail-header-chip detail-header-channel">' + renderChannelChip(channel) + ' <span class="detail-header-chip-text">' + escapeHtml(channelDisplay) + '</span></span>'
      + '</div>';

    // ── Chat bubbles ─────────────────────────────────────────────────
    // Initial render shows just this task's bubble(s). If the task has
    // a conversation_id (Intercom rows do; manual paste rows don't),
    // loadThread() replaces the chat box with the full chronological
    // thread once it loads. Single-bubble fallback keeps the page
    // useful for manual rows and degrades gracefully if /queue/thread
    // fails.
    const initialBubbles = renderThreadFallback(t);

    // ── Left column: classification + routing breadcrumb ─────────────
    // Urgency dropdown — staff can override the AI's value. The set
    // matches URGENCY_OVERRIDE_VALUES in routes/history.js and the
    // CHECK constraint on query_history.urgency_override.
    const curUrgency = t.urgency_override || t.urgency_original || '';
    const urgencyOpts = [
      ['routine',  'Routine'],
      ['same-day', 'Same Day'],
      ['urgent',   'Urgent'],
    ];
    const urgencyOptsHtml =
      (curUrgency ? '' : '<option value="" disabled selected>—</option>')
      + urgencyOpts.map(o =>
          '<option value="' + o[0] + '"' + (curUrgency === o[0] ? ' selected' : '') + '>'
          + o[1] + '</option>'
        ).join('');
    const urgencyEdited = !!(t.urgency_override && t.urgency_override !== t.urgency_original);

    const internalNoteSection = t.internal_note
      ? '<div class="detail-section">'
        + '<div class="detail-section-label">Internal note (routing breadcrumb)</div>'
        + '<div class="detail-internal-note">' + escapeHtml(t.internal_note) + '</div>'
        + '</div>'
      : '';

    // Routing level row hides when value is missing or 'none' — those
    // tasks have no side-effect routing signal, so the row is noise.
    // When Claude does set mild / moderate / severe, the row appears.
    const showRoutingLevel = !!t.clinical_routing_level
      && t.clinical_routing_level !== 'none';

    const upActive   = t.upvoted   === true ? ' active' : '';
    const downActive = t.downvoted === true ? ' active' : '';
    const hasSuggestion = !!(t.draft_response && t.draft_response.trim());

    // Suggestion card lives in the left column under the classification
    // card. White background + dashed border + explicit "Insert into
    // reply" action keeps it readable but visually optional — staff
    // shouldn't feel pressured to use it.
    const suggestionSection = hasSuggestion
      ? '<div class="detail-section">'
      +   '<div class="detail-section-label">'
      +     '<span>Care Station suggests</span>'
      +     '<span class="vote-row">'
      +       '<button class="vote-btn up' + upActive + '" id="voteUpBtn" onclick="voteTask(\'up\')" title="Helpful draft">'
      +         '<span class="vote-icon">&#x1F44D;</span>'
      +       '</button>'
      +       '<button class="vote-btn down' + downActive + '" id="voteDownBtn" onclick="voteTask(\'down\')" title="Needs work">'
      +         '<span class="vote-icon">&#x1F44E;</span>'
      +       '</button>'
      +     '</span>'
      +   '</div>'
      +   '<div class="suggestion-card">'
      +     '<div class="suggestion-text">' + escapeHtml(t.draft_response) + '</div>'
      +     '<div class="suggestion-actions">'
      +       '<button class="action-btn ghost" onclick="insertSuggestion()">Insert into reply</button>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      : '';

    const leftCol =
        '<div class="detail-section">'
      +   '<div class="detail-section-label">Classification &amp; routing</div>'
      +   '<div class="detail-ai-box">'
      +     '<div class="detail-ai-line">'
      +       '<span class="ai-key">Category</span>'
      +       '<span class="ai-val ai-val-category" id="detailCategoryVal">'
      +         renderCategoryTag(t.clinical_category)
      +         '<button class="detail-edit-cat-btn" onclick="openReassign()" title="Correct category (logs as a learning signal)" aria-label="Correct category">'
      +           '<span class="pencil-icon">&#9998;</span>'
      +         '</button>'
      +       '</span>'
      +     '</div>'
      +     '<div class="detail-ai-line">'
      +       '<span class="ai-key">Urgency</span>'
      +       '<span class="ai-val ai-val-urgency">'
      +         '<select id="urgencySelect" class="detail-urgency-select" onchange="updateUrgency(this.value)">'
      +           urgencyOptsHtml
      +         '</select>'
      +         (urgencyEdited ? '<span class="urgency-edited-tag" title="Staff overrode the AI value">edited</span>' : '')
      +       '</span>'
      +     '</div>'
      +     (showRoutingLevel
          ? '<div class="detail-ai-line"><span class="ai-key">Routing level</span><span class="ai-val">' + escapeHtml(t.clinical_routing_level) + '</span></div>'
          : '')
      +   '</div>'
      + '</div>'
      + internalNoteSection
      + suggestionSection
      + '<div class="detail-section">'
      +   '<div class="detail-action-bar inline">'
      +     '<button id="closeNoReplyBtn" class="action-btn neutral" onclick="openCloseNoReply()">Close (no reply)</button>'
      +     '<button id="spawnFollowupBtn" class="action-btn neutral" onclick="openSpawnFollowup()">+ Follow-up task</button>'
      +     '<span id="followupCountChip" class="followup-count-chip" style="display:none"></span>'
      +     '<button id="retaskBtn" class="action-btn warning" onclick="releaseTask()">Release to queue</button>'
      +   '</div>'
      + '</div>';

    // ── Right column: chat + reply box + Send ─────────────────────────
    const rightCol =
        '<div class="detail-section">'
      +   '<div class="detail-section-label">Conversation</div>'
      +   '<div class="chat-box" id="chatBox">'
      +     initialBubbles
      +   '</div>'
      + '</div>'

      + '<div class="detail-section">'
      +   '<div class="detail-section-label">Your reply</div>'
      +   '<textarea id="detailReply" class="detail-reply-textarea" placeholder="Type your reply…"></textarea>'
      + '</div>'

      + '<div class="detail-section">'
      +   '<div class="detail-action-bar inline detail-action-bar-send">'
      +     '<button id="sendBtn" class="action-btn primary" onclick="sendTask()">Send <span class="sandbox-tag">Sandbox</span></button>'
      +   '</div>'
      + '</div>';

    // ── Assemble two-column body ─────────────────────────────────────
    document.getElementById('detailViewBody').innerHTML =
        '<div class="detail-grid">'
      +   '<div class="detail-col-left">' + leftCol + '</div>'
      +   '<div class="detail-col-right">' + rightCol + '</div>'
      + '</div>';

    // Sync the follow-up count chip for the currently-open task.
    // state.followupsStagedByParent[tid] survives only within this
    // session; we don't fetch existing pending_parent children on
    // reload (out of scope — see PLAN for "originator visibility").
    refreshFollowupChip();

    // Fetch the full conversation thread (if this row is part of one)
    // and replace the chat-box content. Falls back silently to the
    // single-bubble render if the task has no conversation_id (e.g.,
    // manual paste rows) or the endpoint errors.
    if (t.conversation_id) {
      loadThread(t.conversation_id, t.id);
    }
  }

  // Single-bubble fallback used as the initial chat-box content. Also
  // the final answer for any task without a conversation_id.
  function renderThreadFallback(t) {
    const patientBubble = t.patient_message
      ? renderBubble({
          side: 'patient', author: 'Patient',
          time: formatDateTime(t.created_at),
          text: t.patient_message,
        })
      : '';
    const staffBubble = (t.actual_response_sent && t.status === 'sent')
      ? renderBubble({
          side: 'staff', author: 'Staff reply',
          time: 'sent',
          text: t.actual_response_sent,
        })
      : '';
    return patientBubble + staffBubble;
  }

  // Build a chat bubble HTML fragment. Centralized so the thread
  // renderer and the fallback agree on shape + escaping.
  function renderBubble(opts) {
    const isCurrent = opts.isCurrent ? ' is-current' : '';
    return (
      '<div class="chat-message ' + opts.side + isCurrent + '">'
      +   '<div class="chat-bubble">'
      +     '<div class="chat-bubble-meta">'
      +       '<span class="chat-author">' + escapeHtml(opts.author || '') + '</span>'
      +       '<span class="chat-time">' + escapeHtml(opts.time || '') + '</span>'
      +     '</div>'
      +     '<div class="chat-bubble-text">' + escapeHtml(opts.text || '') + '</div>'
      +   '</div>'
      + '</div>'
    );
  }

  // Build a system-note HTML fragment (centered, smaller, italic).
  // Used inline in the thread for spawned follow-ups, close-no-reply
  // events, and other workflow markers.
  function renderSystemNote(opts) {
    return (
      '<div class="chat-system-note">'
      +   '<div class="chat-system-note-title">' + escapeHtml(opts.title || '') + '</div>'
      +   (opts.body
            ? '<div class="chat-system-note-body">' + escapeHtml(opts.body) + '</div>'
            : '')
      + '</div>'
    );
  }

  // Intercom system-placeholder bodies that aren't real patient text.
  // Mirrors INTERCOM_SYSTEM_PLACEHOLDERS in netlify/functions/intercom.js
  // (which prevents new inserts). Older rows from before that filter
  // landed need to be hidden at render time so the chat-box doesn't
  // surface noise to staff.
  const SPA_SYSTEM_PLACEHOLDER_MESSAGES = new Set([
    'SYSTEM MESSAGE: CONVERSATION STARTED',
  ]);

  function isSystemPlaceholderText(s) {
    return typeof s === 'string' && SPA_SYSTEM_PLACEHOLDER_MESSAGES.has(s.trim());
  }

  // Render the thread rows as a chronological stream of bubbles +
  // system notes. The current task's row is highlighted; follow-ups
  // (parent_task_id set) render as system notes; closed_no_reply
  // rows render as system notes.
  function renderThreadBubbles(rows, currentTaskId) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return '<div class="chat-system-note">No conversation history available.</div>';
    }
    const parts = [];
    for (const r of rows) {
      // Drop noise rows (e.g., Intercom's "CONVERSATION STARTED"
      // placeholder, which predates the insert-time filter). Skip only
      // when there's no real staff reply on the same row.
      if (isSystemPlaceholderText(r.patient_message) && !r.actual_response_sent) {
        continue;
      }
      const isCurrent = r.id === currentTaskId;
      // Follow-up spawn — render as a system note positioned at its
      // creation time. The internal_note breadcrumb is self-describing.
      if (r.parent_task_id) {
        parts.push(renderSystemNote({
          title: 'Follow-up created' + (r.clinical_category ? ' → ' + r.clinical_category : '') + ' · ' + formatDateTime(r.created_at),
          body: r.internal_note || '',
        }));
        continue;
      }
      // Close-no-reply — render as a system note marking the task
      // close. Don't suppress the patient bubble on the same row.
      if (r.status === 'closed_no_reply') {
        if (r.patient_message) {
          parts.push(renderBubble({
            side: 'patient', author: 'Patient',
            time: formatDateTime(r.created_at),
            text: r.patient_message,
            isCurrent: isCurrent,
          }));
        }
        parts.push(renderSystemNote({
          title: 'Task closed without reply · ' + formatDateTime(r.created_at),
          body: r.internal_note || '',
        }));
        continue;
      }
      // Regular row — patient bubble (if any) + staff bubble (if sent).
      if (r.patient_message) {
        parts.push(renderBubble({
          side: 'patient', author: 'Patient',
          time: formatDateTime(r.created_at),
          text: r.patient_message,
          isCurrent: isCurrent,
        }));
      }
      if (r.actual_response_sent) {
        const author = r.nurse_name ? ('Staff (' + r.nurse_name + ')') : 'Staff reply';
        parts.push(renderBubble({
          side: 'staff', author: author,
          time: r.status === 'sent' ? 'sent' : formatDateTime(r.created_at),
          text: r.actual_response_sent,
          isCurrent: isCurrent,
        }));
      }
    }
    return parts.join('');
  }

  async function loadThread(conversationId, currentTaskId) {
    const box = document.getElementById('chatBox');
    if (!box) return;
    box.classList.add('is-loading');
    try {
      const resp = await api(
        '/queue/thread?conversation_id=' + encodeURIComponent(conversationId),
        { method: 'GET' }
      );
      const rows = (resp && Array.isArray(resp.rows)) ? resp.rows : [];
      // Race guard: only update if the user hasn't navigated away.
      if (state.openTaskId !== currentTaskId) return;
      box.innerHTML = renderThreadBubbles(rows, currentTaskId);
      box.classList.remove('is-loading');
      // Scroll to the highlighted current bubble if present, else to
      // the bottom (most recent message). Set scrollTop on the chat-box
      // directly — scrollIntoView would also scroll the document, which
      // pushes the sticky .detail-header up behind the global .topbar
      // on direct #task/<id> navigation.
      const cur = box.querySelector('.chat-message.is-current');
      if (cur) {
        box.scrollTop = cur.offsetTop - (box.clientHeight / 2) + (cur.clientHeight / 2);
      } else {
        box.scrollTop = box.scrollHeight;
      }
    } catch (e) {
      // Keep the fallback bubble; surface the failure quietly.
      box.classList.remove('is-loading');
      console.error('loadThread:', e.message);
    }
  }

  function refreshFollowupChip() {
    const chip = document.getElementById('followupCountChip');
    if (!chip) return;
    const tid = state.openTaskId;
    const map = state.followupsStagedByParent || {};
    const n = (tid && map[tid]) ? map[tid] : 0;
    if (n > 0) {
      chip.textContent = n + ' follow-up' + (n === 1 ? '' : 's') + ' staged';
      chip.style.display = '';
    } else {
      chip.style.display = 'none';
    }
    // Surface the count in the close-no-reply modal hint too, if open.
    const hint = document.getElementById('closeNoReplyFollowupHint');
    const hintCount = document.getElementById('closeNoReplyFollowupCount');
    if (hint && hintCount) {
      if (n > 0) {
        hintCount.textContent = String(n);
        hint.style.display = '';
      } else {
        hint.style.display = 'none';
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Task actions
  // ─────────────────────────────────────────────────────────────────

  // Helper for the action buttons — disables every action button
  // for the duration of the in-flight call so a double-click or
  // accidental second click can't race the first request to a
  // now-stale DB state (the cause of the "Re-task 404 after success"
  // pattern reported 2026-05-17). Sets the active button's text
  // while disabled so the user sees something's happening.
  function withButtonLock(activeBtnId, busyLabel, fn) {
    const ids = ['sendBtn', 'retaskBtn', 'reassignBtn', 'closeNoReplyBtn', 'spawnFollowupBtn'];
    const buttons = ids.map(id => document.getElementById(id)).filter(Boolean);
    const active = document.getElementById(activeBtnId);
    const originalText = active ? active.innerHTML : '';
    buttons.forEach(b => { b.disabled = true; });
    if (active) active.innerHTML = busyLabel;
    return (async () => {
      try {
        await fn();
      } finally {
        // Re-enable. On a successful action that closes the panel,
        // the buttons disappear with the panel anyway; this only
        // matters on the failure path.
        buttons.forEach(b => { b.disabled = false; });
        if (active && active.isConnected) active.innerHTML = originalText;
      }
    })();
  }

  window.sendTask = function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const textarea = document.getElementById('detailReply');
    const finalText = (textarea && textarea.value || '').trim();
    if (!finalText) {
      toast('Cannot send an empty response.', 'warn');
      return;
    }
    return withButtonLock('sendBtn', 'Sending…', async () => {
      try {
        const resp = await api('/queue/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triage_id: tid, final_text: finalText }),
        });
        const sentVia = resp && resp.sent_via;
        const sandboxed = sentVia && sentVia.indexOf('sandbox:') === 0;
        const base = sandboxed
          ? 'Sent (sandbox — no Intercom delivery). State recorded.'
          : 'Sent via ' + sentVia;
        toast(base + followupSuffix(resp && resp.followups_fired, resp && resp.followup_categories, 'released'), sandboxed ? 'warn' : 'success');
        clearStagedFollowupsFor(tid);
        // Return to queue view; showQueueView() also refreshes.
        window.location.hash = '#queue';
      } catch (e) {
        toast('Send failed: ' + e.message, 'error');
      }
    });
  };

  // Compose the trailing " · N follow-up(s) released to <Cat1, Cat2>"
  // suffix used by the Send and Close-no-reply toasts. Returns the
  // empty string when count is 0 (most tasks don't have follow-ups).
  function followupSuffix(count, categories, verb) {
    const n = Number.isFinite(count) ? count : 0;
    if (n <= 0) return '';
    const cats = Array.isArray(categories) && categories.length
      ? ' to ' + categories.join(', ')
      : '';
    return ' · ' + n + ' follow-up' + (n === 1 ? '' : 's') + ' ' + verb + cats + '.';
  }

  function clearStagedFollowupsFor(tid) {
    if (state.followupsStagedByParent && tid && state.followupsStagedByParent[tid] != null) {
      delete state.followupsStagedByParent[tid];
    }
  }

  // "Release to queue" (formerly "re-task") — drops the task back
  // into the general pool. Wrapped in a confirmation modal so an
  // accidental click doesn't lose the staffer's place.
  window.releaseTask = function () {
    if (!state.openTaskId) return;
    document.getElementById('releaseModal').classList.add('active');
    document.getElementById('releaseOverlay').classList.add('active');
    document.getElementById('releaseModal').setAttribute('aria-hidden', 'false');
  };

  window.closeReleaseConfirm = function () {
    document.getElementById('releaseModal').classList.remove('active');
    document.getElementById('releaseOverlay').classList.remove('active');
    document.getElementById('releaseModal').setAttribute('aria-hidden', 'true');
  };

  // The actual "release" PATCH — calls the existing /queue/retask
  // endpoint (renaming the backend route is a separate concern;
  // the SPA-facing label is what matters for users).
  window.confirmRelease = function () {
    const tid = state.openTaskId;
    if (!tid) return;
    closeReleaseConfirm();
    return withButtonLock('retaskBtn', 'Releasing…', async () => {
      try {
        const resp = await api('/queue/retask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triage_id: tid }),
        });
        toast('Task released to the queue.' + followupSuffix(resp && resp.followups_dropped, null, 'dropped'), 'success');
        clearStagedFollowupsFor(tid);
        window.location.hash = '#queue';
      } catch (e) {
        toast('Release failed: ' + e.message, 'error');
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────
  // Close (no reply) modal — terminal close without a patient reply.
  // Required internal note. Fires any pending_parent children of the
  // current task into their target queues on close.
  // ─────────────────────────────────────────────────────────────────

  window.openCloseNoReply = function () {
    if (!state.openTaskId) return;
    const note = document.getElementById('closeNoReplyNote');
    if (note) note.value = '';
    refreshFollowupChip();
    document.getElementById('closeNoReplyModal').classList.add('active');
    document.getElementById('closeNoReplyOverlay').classList.add('active');
    document.getElementById('closeNoReplyModal').setAttribute('aria-hidden', 'false');
  };

  window.closeNoReplyCancel = function () {
    document.getElementById('closeNoReplyModal').classList.remove('active');
    document.getElementById('closeNoReplyOverlay').classList.remove('active');
    document.getElementById('closeNoReplyModal').setAttribute('aria-hidden', 'true');
  };

  window.confirmCloseNoReply = function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const noteEl = document.getElementById('closeNoReplyNote');
    const note = (noteEl && noteEl.value || '').trim();
    if (note.length < 3) {
      toast('Note required (at least 3 characters).', 'warn');
      if (noteEl) noteEl.focus();
      return;
    }
    closeNoReplyCancel();
    return withButtonLock('closeNoReplyBtn', 'Closing…', async () => {
      try {
        const resp = await api('/queue/close-no-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triage_id: tid, note: note }),
        });
        toast('Task closed (no reply).' + followupSuffix(resp && resp.followups_fired, resp && resp.followup_categories, 'released'), 'success');
        clearStagedFollowupsFor(tid);
        window.location.hash = '#queue';
      } catch (e) {
        toast('Close failed: ' + e.message, 'error');
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────
  // Spawn follow-up modal — create a child task in another category.
  // The child stays out of every queue until the parent terminates
  // (Send or Close-no-reply); releasing the parent drops the child.
  // ─────────────────────────────────────────────────────────────────

  window.openSpawnFollowup = function () {
    if (!state.openTaskId) return;
    const sel = document.getElementById('spawnFollowupSelect');
    if (sel) {
      sel.innerHTML = '';
      state.categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.category_name;
        opt.textContent = c.category_name;
        sel.appendChild(opt);
      });
    }
    const note = document.getElementById('spawnFollowupNote');
    const draft = document.getElementById('spawnFollowupDraft');
    const pf = document.getElementById('spawnFollowupPatientFacing');
    if (note) note.value = '';
    if (draft) draft.value = '';
    if (pf) pf.checked = true;
    // Fresh submission — drop any key left over from a prior modal
    // (e.g., one the user closed without retrying after a failure).
    pendingFollowupKey = null;
    document.getElementById('spawnFollowupModal').classList.add('active');
    document.getElementById('spawnFollowupOverlay').classList.add('active');
    document.getElementById('spawnFollowupModal').setAttribute('aria-hidden', 'false');
  };

  window.closeSpawnFollowup = function () {
    document.getElementById('spawnFollowupModal').classList.remove('active');
    document.getElementById('spawnFollowupOverlay').classList.remove('active');
    document.getElementById('spawnFollowupModal').setAttribute('aria-hidden', 'true');
  };

  window.confirmSpawnFollowup = function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const sel = document.getElementById('spawnFollowupSelect');
    const noteEl = document.getElementById('spawnFollowupNote');
    const draftEl = document.getElementById('spawnFollowupDraft');
    const pfEl = document.getElementById('spawnFollowupPatientFacing');
    const targetCategory = sel ? sel.value : '';
    const note = (noteEl && noteEl.value || '').trim();
    const draftResponse = (draftEl && draftEl.value || '').trim();
    const patientFacing = pfEl ? !!pfEl.checked : true;
    if (!targetCategory) {
      toast('Pick a target category.', 'warn');
      return;
    }
    if (note.length < 3) {
      toast('Note required (at least 3 characters).', 'warn');
      if (noteEl) noteEl.focus();
      return;
    }
    // Generate the idempotency key on the first attempt and keep it
    // across retries of the same submission. The server dedupes on
    // (company_id, idempotency_key) — see migration 0032 — so a
    // retry after a "Failed to fetch" produces zero duplicates.
    if (!pendingFollowupKey) {
      pendingFollowupKey = makeIdempotencyKey();
    }
    return withButtonLock('spawnFollowupBtn', 'Saving…', async () => {
      try {
        await api('/queue/spawn-followup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_id: tid,
            target_category: targetCategory,
            note: note,
            draft_response: draftResponse || undefined,
            patient_facing: patientFacing,
            idempotency_key: pendingFollowupKey,
          }),
        });
        if (!state.followupsStagedByParent[tid]) state.followupsStagedByParent[tid] = 0;
        state.followupsStagedByParent[tid] += 1;
        refreshFollowupChip();
        // Close the modal only after a confirmed success — failures
        // leave it open so the user can retry without retyping. The
        // key is cleared here so the next submission gets a fresh one.
        pendingFollowupKey = null;
        closeSpawnFollowup();
        toast('Follow-up staged. It will fire when you Send or Close this task.', 'success');
      } catch (e) {
        // Keep the modal open and the key in place. If this was a
        // transient network failure that already created the row on
        // the server, the next attempt with the same key returns the
        // original row instead of inserting a duplicate.
        toast('Follow-up create failed: ' + e.message, 'error');
      }
    });
  };

  // Copies the AI suggestion into the reply textarea. If staff has
  // already typed something, confirm before overwriting so a fat-finger
  // doesn't lose their work.
  window.insertSuggestion = function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const t = state.queue.find(x => x.id === tid);
    if (!t) return;
    const text = t.draft_response || '';
    if (!text.trim()) return;
    const reply = document.getElementById('detailReply');
    if (!reply) return;
    const current = (reply.value || '').trim();
    if (current && !window.confirm('Replace what you\'ve typed with the suggested draft?')) {
      return;
    }
    reply.value = text;
    reply.focus();
  };

  // Thumbs up / down on the AI draft. Records to query_history's
  // upvoted/downvoted columns (mutually exclusive); feeds the existing
  // learning-loop reward signal.
  window.voteTask = async function (vote) {
    const tid = state.openTaskId;
    if (!tid) return;
    if (vote !== 'up' && vote !== 'down') return;
    const upBtn = document.getElementById('voteUpBtn');
    const downBtn = document.getElementById('voteDownBtn');
    if (upBtn) upBtn.disabled = true;
    if (downBtn) downBtn.disabled = true;
    try {
      await api('/queue/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triage_id: tid, vote: vote }),
      });
      // Optimistic UI update: flip the active classes locally so the
      // user sees the result immediately. Server is the source of
      // truth on reload.
      const t = state.queue.find(x => x.id === tid);
      if (t) {
        t.upvoted   = (vote === 'up');
        t.downvoted = (vote === 'down');
      }
      if (upBtn)   upBtn.classList.toggle('active', vote === 'up');
      if (downBtn) downBtn.classList.toggle('active', vote === 'down');
      toast(vote === 'up' ? 'Thanks — recorded as a good draft.' : 'Got it — noted as needs work.', 'success');
    } catch (e) {
      toast('Vote failed: ' + e.message, 'error');
    } finally {
      if (upBtn) upBtn.disabled = false;
      if (downBtn) downBtn.disabled = false;
    }
  };

  // Urgency dropdown change — writes urgency_override via the existing
  // history.update_urgency endpoint. The server applies a clinical role
  // gate (non-clinical staff get a 403 on clinical-tier rows).
  window.updateUrgency = async function (newValue) {
    const tid = state.openTaskId;
    if (!tid) return;
    if (newValue !== 'routine' && newValue !== 'same-day' && newValue !== 'urgent') return;
    const sel = document.getElementById('urgencySelect');
    const t = state.queue.find(x => x.id === tid);
    const previous = t ? (t.urgency_override || t.urgency_original || '') : '';
    if (sel) sel.disabled = true;
    try {
      await api('/.netlify/functions/kb/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_urgency',
          id: tid,
          urgency_override: newValue,
        }),
      });
      if (t) t.urgency_override = newValue;
      toast('Urgency saved as "' + newValue + '".', 'success');
    } catch (e) {
      if (sel && previous) sel.value = previous;
      toast('Save failed: ' + e.message, 'error');
    } finally {
      if (sel) sel.disabled = false;
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Reassign modal
  // ─────────────────────────────────────────────────────────────────

  window.openReassign = function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const sel = document.getElementById('reassignSelect');
    sel.innerHTML = '';
    state.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.category_name;
      opt.textContent = c.category_name;
      sel.appendChild(opt);
    });
    document.getElementById('reassignNote').value = '';
    document.getElementById('reassignModal').classList.add('active');
    document.getElementById('reassignOverlay').classList.add('active');
    document.getElementById('reassignModal').setAttribute('aria-hidden', 'false');
  };

  window.closeReassign = function () {
    document.getElementById('reassignModal').classList.remove('active');
    document.getElementById('reassignOverlay').classList.remove('active');
    document.getElementById('reassignModal').setAttribute('aria-hidden', 'true');
  };

  window.confirmReassign = async function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const newCat = document.getElementById('reassignSelect').value;
    const note = document.getElementById('reassignNote').value.trim();
    if (!newCat) {
      toast('Pick a category.', 'warn');
      return;
    }
    try {
      const resp = await api('/queue/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triage_id: tid,
          new_category: newCat,
          note: note || undefined,
        }),
      });
      // Server logs the correction to task_reassignments (learning
      // signal) and updates clinical_category, but leaves ownership
      // with the caller. Update local state + the category chip in
      // place so staff stays on the task and keeps working.
      const t = state.queue.find(x => x.id === tid);
      if (t) t.clinical_category = resp.to_category || newCat;
      const chip = document.getElementById('detailCategoryVal');
      if (chip) {
        chip.innerHTML =
            renderCategoryTag(resp.to_category || newCat)
          + '<button class="detail-edit-cat-btn" onclick="openReassign()" title="Correct category (logs as a learning signal)" aria-label="Correct category">'
          +   '<span class="pencil-icon">&#9998;</span>'
          + '</button>';
      }
      toast('Category corrected: ' + (resp.from_category || '—') + ' → ' + (resp.to_category || newCat) + '. Logged for training.', 'success');
      closeReassign();
    } catch (e) {
      toast('Correction failed: ' + e.message, 'error');
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Profile panel + sign out
  // ─────────────────────────────────────────────────────────────────

  window.openProfile = function () {
    document.getElementById('profilePanel').classList.add('active');
    document.getElementById('profileOverlay').classList.add('active');
  };
  window.closeProfile = function () {
    document.getElementById('profilePanel').classList.remove('active');
    document.getElementById('profileOverlay').classList.remove('active');
  };

  window.goToManual = function () {
    window.location.href = '/manual.html';  // The legacy Run Triage SPA.
  };

  // Profile-panel wrappers for the super-user-only nav buttons. Close
  // the panel first so the destination view is fully visible after the
  // hash change.
  window.goToEvents = function () {
    closeProfile();
    navigateToEvents();
  };
  window.goToStaff = function () {
    closeProfile();
    navigateToStaff();
  };

  window.signOut = function () {
    window.RELAI_AUTH.setSigningOut(true);
    localStorage.removeItem('relai_session');
    localStorage.removeItem('relai_profile_cache');
    fetch('/.netlify/functions/auth/signout', { method: 'POST' }).catch(() => {});
    // After sign-in the tasking SPA is the default destination — '/' is
    // now this page (formerly tasking.html). login.html's getPostLoginUrl
    // validates the ?next= value as a same-origin absolute path.
    window.location.replace('/login.html?next=/');
  };

  window.refreshQueue = refreshQueue;

  // ─────────────────────────────────────────────────────────────────
  // Event Log (super-user only)
  // ─────────────────────────────────────────────────────────────────
  //
  // Three sub-tabs, each backed by an /admin/events/<name> endpoint.
  // Each sub-tab renders a table of recent rows (newest-first, capped
  // server-side at MAX_LIMIT). Click a row to see full detail
  // (especially raw_payload for inbound webhook events).

  // Loaded rows for the active sub-tab. Replaced on date-filter
  // change / subtab switch / refresh; appended on Load more.
  state.eventsRows = [];
  state.eventsSubtab = 'inbound';
  state.eventsSince = null;         // ISO string or null
  state.eventsDateRange = 'all';    // dropdown value
  state.eventsQuery = '';           // current keyword (client-side filter)
  state.eventsHasMore = false;      // last fetch hit the limit?

  const EVENTS_PAGE_SIZE = 50;

  // Build the API URL with current filter + pagination params.
  function buildEventsUrl(subtab, offset) {
    const params = new URLSearchParams();
    params.set('limit', String(EVENTS_PAGE_SIZE));
    if (offset > 0) params.set('offset', String(offset));
    if (state.eventsSince) params.set('since', state.eventsSince);
    const qs = params.toString();
    return '/.netlify/functions/kb/admin/events/' + subtab + (qs ? '?' + qs : '');
  }

  // Translate the date-range dropdown value into an ISO `since`
  // string the server understands. 'all' returns null.
  function dateRangeToSince(range) {
    const now = Date.now();
    const offsets = {
      '1h':  60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d':  7  * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const off = offsets[range];
    if (!off) return null;
    return new Date(now - off).toISOString();
  }

  async function loadEvents(subtab, options) {
    // Learning subtab is shape-incompatible with the list subtabs
    // (single aggregate payload, no pagination, no per-row filter).
    // Branch early before the list-shaped fetch path.
    if (subtab === 'learning') return loadLearning();
    if (subtab === 'conversations') return loadConversations();

    options = options || {};
    const append = !!options.append;
    const body = document.getElementById('eventsBody');
    const loadMoreBtn = document.getElementById('eventsLoadMoreBtn');
    if (!body) return;

    if (!append) {
      body.innerHTML = '<div class="loading-row">Loading…</div>';
      state.eventsRows = [];
    }
    if (loadMoreBtn) loadMoreBtn.disabled = true;

    try {
      const offset = append ? state.eventsRows.length : 0;
      const url = buildEventsUrl(subtab, offset);
      const resp = await api(url, { method: 'GET' });
      const events = (resp && resp.events) || [];

      if (append) {
        state.eventsRows = state.eventsRows.concat(events);
      } else {
        state.eventsRows = events;
      }
      // If the fetch returned a full page, assume more available
      // (next call returns 0 rows → hasMore flips false).
      state.eventsHasMore = events.length >= EVENTS_PAGE_SIZE;

      renderFilteredEvents();
      setText('eventsCount' + capFirst(subtab),
        '(' + state.eventsRows.length + (state.eventsHasMore ? '+' : '') + ')');
    } catch (e) {
      body.innerHTML = '<div class="loading-row" style="color:var(--severe)">Failed to load: ' + escapeHtml(e.message) + '</div>';
      state.eventsHasMore = false;
    } finally {
      if (loadMoreBtn) loadMoreBtn.disabled = false;
      updateLoadMoreVisibility();
    }
  }

  // Conversations subtab — lists the N most-recent primary conversations
  // (one row per conversation_id) regardless of who owns or has pulled
  // them. Super-user-only on the server. Powers the audit-view workflow:
  // click a row to deep-link into the task via the /queue/peek fallback
  // in showDetailView.
  async function loadConversations() {
    const body = document.getElementById('eventsBody');
    if (!body) return;
    body.innerHTML = '<div class="loading-row">Loading…</div>';
    state.eventsRows = [];
    state.eventsHasMore = false;
    updateLoadMoreVisibility();
    try {
      const resp = await api('/queue/conversations/recent?limit=10', { method: 'GET' });
      const rows = (resp && resp.rows) || [];
      state.eventsRows = rows;
      renderConversationsList(rows);
      setText('eventsCountConversations', '(' + rows.length + ')');
    } catch (e) {
      body.innerHTML = '<div class="loading-row" style="color:var(--severe)">Failed to load: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderConversationsList(rows) {
    const body = document.getElementById('eventsBody');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<div class="loading-row">No conversations yet.</div>';
      return;
    }
    const html = '<table class="events-table"><thead><tr>'
      + '<th>Received</th>'
      + '<th>Patient</th>'
      + '<th>Channel</th>'
      + '<th>Status</th>'
      + '<th>Category</th>'
      + '<th>Action</th>'
      + '</tr></thead><tbody>'
      + rows.map(r => {
        const name = r.patient_name || 'Unknown';
        const email = r.patient_email || '';
        const channel = r.source_channel || '—';
        const status = displayStatus(r.status || '');
        const category = r.clinical_category || '—';
        return '<tr>'
          + '<td>' + escapeHtml(formatDateTime(r.created_at)) + '</td>'
          + '<td>' + escapeHtml(name)
            + (email ? '<br><span class="events-sub">' + escapeHtml(email) + '</span>' : '')
          + '</td>'
          + '<td>' + escapeHtml(channel) + '</td>'
          + '<td>' + escapeHtml(status) + '</td>'
          + '<td>' + escapeHtml(category) + '</td>'
          + '<td><a href="#task/' + escapeHtml(r.id) + '">Open &rarr;</a></td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>';
    body.innerHTML = html;
  }

  // Learning subtab — fetches the aggregate payload, renders three
  // small tables. No pagination, no keyword filter (the underlying
  // data is already aggregated). The since (date-range) filter IS
  // honored — server-side, same way as the list subtabs.
  async function loadLearning() {
    const body = document.getElementById('eventsBody');
    if (!body) return;
    body.innerHTML = '<div class="loading-row">Loading…</div>';
    state.eventsRows = [];
    state.eventsHasMore = false;
    updateLoadMoreVisibility();

    try {
      const params = new URLSearchParams();
      if (state.eventsSince) params.set('since', state.eventsSince);
      const qs = params.toString();
      const url = '/.netlify/functions/kb/admin/events/learning' + (qs ? '?' + qs : '');
      const resp = await api(url, { method: 'GET' });
      renderLearning(resp || {});
      const n = (resp && resp.sample_size) || 0;
      setText('eventsCountLearning', '(' + n + ')');
    } catch (e) {
      body.innerHTML = '<div class="loading-row" style="color:var(--severe)">Failed to load: ' + escapeHtml(e.message) + '</div>';
    }
  }

  // Apply the client-side keyword filter to state.eventsRows and
  // re-render. Server already filtered by date (?since).
  function renderFilteredEvents() {
    const subtab = state.eventsSubtab;
    const q = (state.eventsQuery || '').trim().toLowerCase();
    let rows = state.eventsRows;
    if (q) {
      rows = rows.filter(r => matchesKeyword(r, subtab, q));
    }
    renderEventsList(subtab, rows);
    const filterStatus = document.getElementById('eventsFilterStatus');
    if (filterStatus) {
      if (q && rows.length !== state.eventsRows.length) {
        filterStatus.textContent = 'Showing ' + rows.length + ' of ' + state.eventsRows.length + ' loaded';
      } else {
        filterStatus.textContent = '';
      }
    }
  }

  // Per-subtab keyword match: searches the columns that matter for
  // each stream. Case-insensitive substring match.
  function matchesKeyword(row, subtab, q) {
    if (!row) return false;
    if (subtab === 'inbound') {
      return [
        row.topic, row.processed_reason, row.external_id, row.source_channel,
      ].some(v => v && String(v).toLowerCase().indexOf(q) !== -1);
    }
    if (subtab === 'reviews') {
      return [
        row.clinical_category, row.source_channel, row.external_id,
        row.patient_message, row.internal_note, row.urgency_original,
      ].some(v => v && String(v).toLowerCase().indexOf(q) !== -1);
    }
    if (subtab === 'errors') {
      return [
        row.event_type, row.entity_type, row.entity_id, row.actor_name,
      ].some(v => v && String(v).toLowerCase().indexOf(q) !== -1);
    }
    // 'learning' renders aggregates, not rows — no keyword filter.
    return false;
  }

  function updateLoadMoreVisibility() {
    const row = document.getElementById('eventsLoadMoreRow');
    if (!row) return;
    row.style.display = state.eventsHasMore ? '' : 'none';
  }

  function capFirst(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  window.reloadEvents = function () {
    loadEvents(state.eventsSubtab);
  };

  window.applyEventsDateFilter = function (range) {
    state.eventsDateRange = range;
    state.eventsSince = dateRangeToSince(range);
    loadEvents(state.eventsSubtab);
  };

  window.applyEventsKeywordFilter = function (text) {
    state.eventsQuery = text || '';
    // Pure client-side filter — no refetch.
    renderFilteredEvents();
  };

  window.loadMoreEvents = function () {
    loadEvents(state.eventsSubtab, { append: true });
  };

  function renderEventsList(subtab, events) {
    const body = document.getElementById('eventsBody');
    if (events.length === 0) {
      body.innerHTML = '<div class="empty-state">'
        + '<div class="empty-icon">✓</div>'
        + '<div class="empty-title">No events in this stream</div>'
        + '<div class="empty-body">Nothing to investigate right now.</div>'
        + '</div>';
      return;
    }
    if (subtab === 'inbound') {
      body.innerHTML = renderInboundTable(events);
    } else if (subtab === 'reviews') {
      body.innerHTML = renderReviewsTable(events);
    } else {
      body.innerHTML = renderErrorsTable(events);
    }
    // Click handlers on each row
    body.querySelectorAll('.events-row').forEach((row, i) => {
      row.addEventListener('click', () => openEventDetail(subtab, events[i]));
    });
  }

  function renderInboundTable(events) {
    const rows = events.map(e => {
      const reason = e.processed_reason || (e.processed ? 'inserted' : 'unknown');
      const reasonCls = e.processed ? 'ok' : 'skipped';
      return '<tr class="events-row">'
        + '<td class="events-time">' + escapeHtml(formatDateTime(e.created_at)) + '</td>'
        + '<td>' + escapeHtml(e.topic || '—') + '</td>'
        + '<td><span class="events-reason ' + reasonCls + '">' + escapeHtml(reason) + '</span></td>'
        + '<td class="events-id">' + escapeHtml((e.external_id || '').slice(0, 32)) + '</td>'
        + '<td>' + (e.triage_id ? '<a href="#task/' + escapeHtml(e.triage_id) + '" onclick="event.stopPropagation()">→ task</a>' : '—') + '</td>'
        + '</tr>';
    }).join('');
    return '<table class="events-table">'
      + '<thead><tr><th>Time</th><th>Topic</th><th>Disposition</th><th>External ID</th><th>Triage</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  function renderReviewsTable(events) {
    const rows = events.map(e => {
      const category = e.clinical_category || '(uncategorized)';
      const claimed = e.claimed_by ? 'claimed' : 'unclaimed';
      const preview = (e.patient_message || '').slice(0, 80);
      return '<tr class="events-row">'
        + '<td class="events-time">' + escapeHtml(formatDateTime(e.created_at)) + '</td>'
        + '<td>' + escapeHtml(category) + '</td>'
        + '<td>' + escapeHtml(e.source_channel || '—') + '</td>'
        + '<td><span class="events-reason skipped">' + escapeHtml(claimed) + '</span></td>'
        + '<td class="events-preview">' + escapeHtml(preview) + (preview.length === 80 ? '…' : '') + '</td>'
        + '</tr>';
    }).join('');
    return '<table class="events-table">'
      + '<thead><tr><th>Time</th><th>Category</th><th>Channel</th><th>Ownership</th><th>Preview</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  function renderErrorsTable(events) {
    const rows = events.map(e => {
      return '<tr class="events-row">'
        + '<td class="events-time">' + escapeHtml(formatDateTime(e.created_at)) + '</td>'
        + '<td><span class="events-reason skipped">' + escapeHtml(e.event_type || '—') + '</span></td>'
        + '<td>' + escapeHtml(e.entity_type || '—') + '</td>'
        + '<td class="events-id">' + escapeHtml((e.entity_id || '').slice(0, 12)) + '</td>'
        + '<td>' + escapeHtml(e.actor_name || (e.actor_id ? e.actor_id.slice(0, 8) : '—')) + '</td>'
        + '</tr>';
    }).join('');
    return '<table class="events-table">'
      + '<thead><tr><th>Time</th><th>Event</th><th>Entity</th><th>ID</th><th>Actor</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  // ── Learning signal renderer ─────────────────────────────────────
  // Renders three small aggregate tables, side by side on wide
  // screens, stacked on narrow. Empty sections show an inline note
  // instead of an empty grid — "0 reassignments yet" is the answer
  // until staff starts using the workflow, not a layout problem.

  function pct(num, denom) {
    if (!denom) return '—';
    return Math.round((num / denom) * 100) + '%';
  }

  function renderLearning(payload) {
    const cal = payload && payload.calibration;
    const rx  = (payload && payload.reassignment_matrix) || [];
    const cnr = (payload && payload.close_no_reply_by_category) || [];
    const since = payload && payload.since;
    const sampleSize = (payload && payload.sample_size) || 0;

    const body = document.getElementById('eventsBody');
    if (!body) return;

    const header = '<div class="learning-summary">'
      + 'Sample: <b>' + sampleSize + '</b> triage row' + (sampleSize === 1 ? '' : 's')
      + (since ? ' since ' + escapeHtml(since.slice(0, 10)) : ' (all time)')
      + '</div>';

    body.innerHTML = header
      + '<div class="learning-grid">'
      +   renderCalibrationCard(cal)
      +   renderReassignmentCard(rx)
      +   renderCloseNoReplyCard(cnr)
      + '</div>';
  }

  function renderCalibrationCard(cal) {
    const bands = ['low', 'medium', 'certain', 'unknown'];
    const labels = {
      low:     'Low (<0.70)',
      medium:  'Medium [0.70, 1.00)',
      certain: 'Certain (=1.00)',
      unknown: 'Unknown (null)',
    };
    const c = cal || {};
    const rows = bands.map(b => {
      const r = c[b] || { n_total: 0, n_terminal: 0, urgency_changed: 0, category_reassigned: 0, closed_no_reply: 0 };
      const dimmed = r.n_total === 0 ? ' class="dim"' : '';
      return '<tr' + dimmed + '>'
        + '<td>' + escapeHtml(labels[b]) + '</td>'
        + '<td class="num">' + r.n_total + '</td>'
        + '<td class="num">' + pct(r.urgency_changed, r.n_total) + '</td>'
        + '<td class="num">' + pct(r.category_reassigned, r.n_total) + '</td>'
        + '<td class="num">' + pct(r.closed_no_reply, r.n_terminal) + '</td>'
        + '</tr>';
    }).join('');
    return '<section class="learning-card">'
      + '<h3 class="learning-card-title">Confidence calibration</h3>'
      + '<p class="learning-card-help">Does the AI\'s self-rated confidence predict whether staff agreed? If override rates are similar across bands, confidence is not a useful gate.</p>'
      + '<table class="learning-table">'
      +   '<thead><tr>'
      +     '<th>Band</th>'
      +     '<th class="num">N</th>'
      +     '<th class="num" title="urgency_original ≠ urgency_override">Urgency&nbsp;changed</th>'
      +     '<th class="num" title="at least one task_reassignments row">Re-categorised</th>'
      +     '<th class="num" title="status=closed_no_reply / N terminal">Close&nbsp;no&nbsp;reply</th>'
      +   '</tr></thead>'
      +   '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '</section>';
  }

  function renderReassignmentCard(rx) {
    let body;
    if (rx.length === 0) {
      body = '<p class="learning-empty">No re-categorisations recorded in this window yet.</p>';
    } else {
      const rows = rx.map(r =>
        '<tr>'
          + '<td>' + escapeHtml(r.from || '—') + '</td>'
          + '<td>' + escapeHtml(r.to   || '—') + '</td>'
          + '<td class="num">' + r.n + '</td>'
          + '</tr>'
      ).join('');
      body = '<table class="learning-table">'
        + '<thead><tr><th>From</th><th>To</th><th class="num">N</th></tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table>';
    }
    return '<section class="learning-card">'
      + '<h3 class="learning-card-title">Re-categorisation matrix</h3>'
      + '<p class="learning-card-help">Where the AI\'s first-pass routing gets corrected. High-count pairs are candidates for prompt or KB tuning.</p>'
      + body
      + '</section>';
  }

  function renderCloseNoReplyCard(cnr) {
    let body;
    if (cnr.length === 0) {
      body = '<p class="learning-empty">No terminal triage rows in this window yet.</p>';
    } else {
      const rows = cnr.map(c =>
        '<tr>'
          + '<td>' + escapeHtml(c.category) + '</td>'
          + '<td class="num">' + c.n_terminal + '</td>'
          + '<td class="num">' + pct(c.closed_no_reply, c.n_terminal) + '</td>'
          + '</tr>'
      ).join('');
      body = '<table class="learning-table">'
        + '<thead><tr><th>Category</th><th class="num">N terminal</th><th class="num">Close-no-reply&nbsp;%</th></tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table>';
    }
    return '<section class="learning-card">'
      + '<h3 class="learning-card-title">Close-no-reply by category</h3>'
      + '<p class="learning-card-help">Where AI-drafted replies don\'t get sent. High % suggests the draft prompt for that category needs work — or the category shouldn\'t auto-draft at all.</p>'
      + body
      + '</section>';
  }

  function openEventDetail(subtab, event) {
    const titleEl = document.getElementById('eventDetailTitle');
    const bodyEl = document.getElementById('eventDetailBody');
    if (!titleEl || !bodyEl) return;
    let title = subtab + ' event';
    if (subtab === 'inbound') title = (event.topic || 'inbound') + ' · ' + (event.processed_reason || (event.processed ? 'inserted' : 'unknown'));
    else if (subtab === 'reviews') title = (event.clinical_category || 'reviewed task') + ' · ' + (event.source_channel || '—');
    else title = event.event_type || 'error event';
    titleEl.textContent = title;
    bodyEl.innerHTML = '<pre class="event-detail-json">' + escapeHtml(JSON.stringify(event, null, 2)) + '</pre>';
    document.getElementById('eventDetailModal').classList.add('active');
    document.getElementById('eventDetailOverlay').classList.add('active');
  }

  window.closeEventDetail = function () {
    document.getElementById('eventDetailModal').classList.remove('active');
    document.getElementById('eventDetailOverlay').classList.remove('active');
  };

  // Manual "Fetch & triage" UI was removed 2026-05-17. The background
  // worker still runs on the netlify.toml cron (every 4h; tightened
  // to 15–30 min for production per the comment in netlify.toml).
  // Operators who need to nudge it can POST to
  // /.netlify/functions/worker-background via curl — no UI surface.

  // ─────────────────────────────────────────────────────────────────
  // Toast + small helpers
  // ─────────────────────────────────────────────────────────────────

  function toast(msg, kind) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast active' + (kind ? ' ' + kind : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.classList.remove('active'); }, 3500);
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    if (diffMin < 60 * 24) return Math.floor(diffMin / 60) + 'h ago';
    return d.toLocaleDateString();
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
