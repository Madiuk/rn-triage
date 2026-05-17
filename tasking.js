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
 *   2. If no session, redirect to /login.html?next=/tasking.html.
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
  const REVIEW_THRESHOLD   = DEFAULTS.reviewConfidenceThreshold || 0.75;
  const ROUTING_HUB_NAME   = DEFAULTS.routingHubCategory || 'Routing Hub';
  const APP_TITLES         = DEFAULTS.appTitles || ['MD', 'NP', 'DO', 'PA'];

  // ── Supabase config (same project as app.js / login.html) ───────────
  // The anon key is public by design — Supabase RLS is the real
  // boundary. Service-key writes happen only in Netlify Functions.
  const SUPA_URL = 'https://aturbsnqpdtvhrnujrqb.supabase.co';
  const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0dXJic25xcGR0dmhybnVqcnFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc5MTgsImV4cCI6MjA5MzQyMzkxOH0.l7LdmI8PfFiIXa1nIwwauiWh6KnzpwhlpK5uieATsic';

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    user: null,           // Supabase auth user
    profile: null,        // /auth/profile response
    categories: [],       // [{ category_name, is_clinical }, ...]
    queue: [],            // current pending queue (own tasks)
    selectedPullCategories: new Set(),
    openTaskId: null,
    isSigningOut: false,
    refreshInFlight: null,
  };

  // ─────────────────────────────────────────────────────────────────
  // Auth helpers (inline; mirror app.js's pattern)
  // ─────────────────────────────────────────────────────────────────

  function getSession() {
    try { return JSON.parse(localStorage.getItem('relai_session') || 'null'); }
    catch (e) { return null; }
  }
  function getToken() {
    const s = getSession();
    return s ? s.access_token : null;
  }

  async function refreshSupabaseToken() {
    if (state.isSigningOut) return false;
    if (state.refreshInFlight) return state.refreshInFlight;
    state.refreshInFlight = (async function () {
      try {
        const s = getSession();
        if (!s || !s.refresh_token) return false;
        const r = await fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY },
          body: JSON.stringify({ refresh_token: s.refresh_token }),
        });
        if (!r.ok) return false;
        const data = await r.json();
        if (!data || !data.access_token) return false;
        if (state.isSigningOut) return false;
        localStorage.setItem('relai_session', JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || s.refresh_token,
          timestamp: Date.now(),
        }));
        return true;
      } catch (e) {
        console.error('refreshSupabaseToken:', e.message);
        return false;
      } finally {
        state.refreshInFlight = null;
      }
    })();
    return state.refreshInFlight;
  }

  // Bearer-token-attaching fetch with auto-refresh on 401.
  async function authFetch(url, opts) {
    opts = opts || {};
    const baseHeaders = Object.assign({}, opts.headers || {});
    const doFetch = (tok) => {
      const h = Object.assign({}, baseHeaders);
      if (tok) h['Authorization'] = 'Bearer ' + tok;
      return fetch(url, Object.assign({}, opts, { headers: h }));
    };
    let r = await doFetch(getToken());
    if (r.status !== 401) return r;
    const refreshed = await refreshSupabaseToken();
    if (refreshed) return await doFetch(getToken());
    if (getSession()) {
      toast('Session expired — redirecting to login...', 'warn');
      setTimeout(() => {
        localStorage.removeItem('relai_session');
        window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
      }, 1500);
    }
    return r;
  }

  // Convenience: JSON request helper that throws on non-2xx.
  async function api(url, opts) {
    const r = await authFetch(url, opts);
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

  // ─────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────

  async function init() {
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
  }

  function nameToInitials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();
  }

  // ─────────────────────────────────────────────────────────────────
  // Queue load + render
  // ─────────────────────────────────────────────────────────────────

  async function refreshQueue() {
    setQueueSubtitle('Loading...');
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
      setQueueSubtitle('Your queue is empty — pull tasks to begin.');
    } else {
      emptyEl.classList.add('hidden');
      tbody.innerHTML = '';
      tasks.forEach(t => tbody.appendChild(renderTaskRow(t)));
      const dueCount = tasks.filter(t => t.due_state).length;
      const sub = tasks.length + ' of 5 tasks'
        + (dueCount > 0 ? ' · ' + dueCount + ' Due' : '');
      setQueueSubtitle(sub);
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
      + '<td class="summary-cell">' + escapeHtml(summarize(t)) + '</td>'
      + '<td>' + renderStatusBadge(t) + '</td>';
    tr.addEventListener('click', () => openSidePanel(t.id));
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
    // For v0 we don't yet have a separate patient_name field — show
    // a slug from external_id (last segment) so each row is visually
    // distinct, and the external_id itself in a smaller line.
    const ext = t.external_id || '';
    const slug = ext.split(':').slice(-1)[0] || ext.slice(0, 8) || 'patient';
    return '<div class="patient-cell">'
      + '<span class="patient-name">' + escapeHtml('Patient ' + slug.slice(0, 6)) + '</span>'
      + (ext ? '<span class="patient-id">' + escapeHtml(ext) + '</span>' : '')
      + '</div>';
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
    let label = s.charAt(0).toUpperCase() + s.slice(1);
    if (s === 'patient_replied') label = 'Patient replied';
    let badge = '<span class="status-badge ' + s + '">' + label + '</span>';
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
  // Side panel (task detail)
  // ─────────────────────────────────────────────────────────────────

  function openSidePanel(taskId) {
    const t = state.queue.find(x => x.id === taskId);
    if (!t) return;
    state.openTaskId = taskId;

    const cat = t.clinical_category || '—';
    const sev = renderSeverityBadge(t);
    const channel = (t.source_channel || 'manual');
    const conf = (typeof t.ai_confidence === 'number') ? t.ai_confidence : null;
    const confPct = conf != null ? Math.round(conf * 100) : null;
    const confCls = conf == null ? '' : (conf < REVIEW_THRESHOLD ? 'low' : (conf < 0.9 ? 'mid' : ''));

    setText('sidePanelEyebrow', cat + ' · ' + (t.urgency_original || 'routine'));
    setText('sidePanelTitle', 'Patient ' + (t.external_id || t.id).slice(-12));

    // Confidence bar fragment — extracted because nesting a multi-line
    // ternary inside string concatenation parses ambiguously.
    const confHtml = (confPct != null)
      ? '<span class="confidence-bar"><span class="confidence-bar-track">'
        + '<span class="confidence-bar-fill ' + confCls + '" style="width:' + confPct + '%"></span>'
        + '</span>' + confPct + '%</span>'
      : '<span style="color:var(--text-faint)">not provided</span>';

    const internalNoteSection = t.internal_note
      ? '<div class="detail-section">'
        + '<div class="detail-section-label">Internal note (routing breadcrumb)</div>'
        + '<div class="detail-internal-note">' + escapeHtml(t.internal_note) + '</div>'
        + '</div>'
      : '';

    const body = document.getElementById('sidePanelBody');
    body.innerHTML =
      '<div class="detail-section">'
      + '<div class="detail-meta-row">'
      + '<div class="detail-meta-item">'
      +   '<span class="detail-meta-key">Channel</span>'
      +   '<span class="detail-meta-val">' + renderChannelChip(channel) + ' ' + escapeHtml(channel) + '</span>'
      + '</div>'
      + '<div class="detail-meta-item">'
      +   '<span class="detail-meta-key">Received</span>'
      +   '<span class="detail-meta-val">' + escapeHtml(formatDateTime(t.created_at)) + '</span>'
      + '</div>'
      + '<div class="detail-meta-item">'
      +   '<span class="detail-meta-key">Priority</span>'
      +   '<span class="detail-meta-val">' + sev + '</span>'
      + '</div>'
      + '<div class="detail-meta-item">'
      +   '<span class="detail-meta-key">Status</span>'
      +   '<span class="detail-meta-val">' + renderStatusBadge(t) + '</span>'
      + '</div>'
      + '</div>'
      + '</div>'

      + '<div class="detail-section">'
      + '<div class="detail-section-label">Inbound message</div>'
      + '<div class="detail-message-box">' + escapeHtml(t.patient_message || '(empty)') + '</div>'
      + '</div>'

      + '<div class="detail-section">'
      + '<div class="detail-section-label">AI classification</div>'
      + '<div class="detail-ai-box">'
      +   '<div class="detail-ai-line"><span class="ai-key">Category</span><span class="ai-val">' + renderCategoryTag(t.clinical_category) + '</span></div>'
      +   '<div class="detail-ai-line"><span class="ai-key">Urgency</span><span class="ai-val">' + escapeHtml(t.urgency_original || '—') + ' (score ' + (t.urgency_score || 0) + '/10)</span></div>'
      +   '<div class="detail-ai-line"><span class="ai-key">Routing level</span><span class="ai-val">' + escapeHtml(t.clinical_routing_level || 'none') + '</span></div>'
      +   '<div class="detail-ai-line"><span class="ai-key">AI confidence</span><span class="ai-val">' + confHtml + '</span></div>'
      + '</div>'
      + '</div>'

      + internalNoteSection

      + '<div class="detail-section">'
      + '<div class="detail-section-label">AI-drafted response (editable)</div>'
      + '<textarea id="detailDraft" class="detail-draft-textarea">' + escapeHtml(t.draft_response || '') + '</textarea>'
      + '</div>'

      + '<div class="detail-section">'
      + '<div class="detail-section-label">Actions</div>'
      + '<div class="detail-actions">'
      +   '<button class="action-btn primary" onclick="sendTask()">Send <span class="sandbox-tag">Sandbox</span></button>'
      +   '<button class="action-btn" onclick="retaskTask()">Re-task</button>'
      +   '<button class="action-btn warning" onclick="openReassign()">Reassign category</button>'
      + '</div>'
      + '</div>';

    document.getElementById('sidePanel').classList.add('active');
    document.getElementById('sidePanelOverlay').classList.add('active');
    document.getElementById('sidePanel').setAttribute('aria-hidden', 'false');
  }

  window.closeSidePanel = function () {
    document.getElementById('sidePanel').classList.remove('active');
    document.getElementById('sidePanelOverlay').classList.remove('active');
    document.getElementById('sidePanel').setAttribute('aria-hidden', 'true');
    state.openTaskId = null;
  };

  // ─────────────────────────────────────────────────────────────────
  // Task actions
  // ─────────────────────────────────────────────────────────────────

  window.sendTask = async function () {
    const tid = state.openTaskId;
    if (!tid) return;
    const textarea = document.getElementById('detailDraft');
    const finalText = (textarea && textarea.value || '').trim();
    if (!finalText) {
      toast('Cannot send an empty response.', 'warn');
      return;
    }
    try {
      const resp = await api('/queue/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triage_id: tid, final_text: finalText }),
      });
      const sentVia = resp && resp.sent_via;
      const sandboxed = sentVia && sentVia.indexOf('sandbox:') === 0;
      toast(
        sandboxed ? 'Sent (sandbox — no Intercom delivery). State recorded.' : 'Sent via ' + sentVia,
        sandboxed ? 'warn' : 'success'
      );
      closeSidePanel();
      await refreshQueue();
    } catch (e) {
      toast('Send failed: ' + e.message, 'error');
    }
  };

  window.retaskTask = async function () {
    const tid = state.openTaskId;
    if (!tid) return;
    try {
      await api('/queue/retask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triage_id: tid }),
      });
      toast('Task returned to the pool.', 'success');
      closeSidePanel();
      await refreshQueue();
    } catch (e) {
      toast('Re-task failed: ' + e.message, 'error');
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
      toast('Reassigned: ' + (resp.from_category || '—') + ' → ' + resp.to_category, 'success');
      closeReassign();
      closeSidePanel();
      await refreshQueue();
    } catch (e) {
      toast('Reassign failed: ' + e.message, 'error');
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
    window.location.href = '/';  // The legacy Run Triage SPA (current index.html).
  };

  window.signOut = function () {
    state.isSigningOut = true;
    localStorage.removeItem('relai_session');
    localStorage.removeItem('relai_profile_cache');
    fetch('/.netlify/functions/auth/signout', { method: 'POST' }).catch(() => {});
    // Carry tasking.html as the post-login destination so when the
    // user signs back in via login.html, they return here rather than
    // bouncing to the legacy app at /. login.html's getPostLoginUrl
    // validates the ?next= value as a same-origin absolute path.
    window.location.replace('/login.html?next=/tasking.html');
  };

  window.refreshQueue = refreshQueue;

  // ─────────────────────────────────────────────────────────────────
  // Manual "Fetch & triage" — fires the background worker, then
  // refreshes the queue. The scheduler in netlify.toml runs every 4h
  // automatically; this button is the on-demand counterpart for
  // moments when staff sits down and wants today's batch processed
  // immediately.
  //
  // The worker call can take 25-30s for a full batch of 5 (Sonnet
  // latency ~5-7s per row). The button is disabled with a "Triaging…"
  // label during the call so users don't double-fire.
  //
  // The buildWorkerToast helper is defined in tasking-helpers.js
  // (loaded before this file) so it's Node-testable in isolation.
  // ─────────────────────────────────────────────────────────────────

  window.fetchAndTriage = async function () {
    const btn = document.getElementById('fetchBtn');
    if (!btn || btn.disabled) return;
    const labelEl = btn.querySelector('.fetch-btn-label');
    const iconEl = btn.querySelector('.fetch-btn-icon');
    const originalLabel = labelEl ? labelEl.textContent : '';
    const originalIcon = iconEl ? iconEl.textContent : '';

    btn.disabled = true;
    if (labelEl) labelEl.textContent = 'Triaging…';
    if (iconEl) iconEl.textContent = '⏳';
    toast('Firing worker — this may take 30–60s for a full batch.', 'warn');

    try {
      // Worker endpoint is intended for the scheduler / manual fires.
      // No auth required at the function side; the gate is "you have
      // to be on the page already" (logged in to reach tasking.html).
      const r = await fetch('/.netlify/functions/worker', { method: 'GET' });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        toast('Worker error (' + r.status + '): ' + (body && body.error || 'unknown'), 'error');
        return;
      }
      // buildWorkerToast is a top-level helper loaded by tasking-helpers.js
      const t = (typeof buildWorkerToast === 'function')
        ? buildWorkerToast(body)
        : { msg: 'Triaged ' + ((body && body.processed) || 0) + ' task(s).', kind: 'success' };
      toast(t.msg, t.kind);
      await refreshQueue();
    } catch (e) {
      toast('Worker call failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      if (labelEl) labelEl.textContent = originalLabel;
      if (iconEl) iconEl.textContent = originalIcon;
    }
  };

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

  function setQueueSubtitle(s) { setText('queueSubtitle', s); }

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
