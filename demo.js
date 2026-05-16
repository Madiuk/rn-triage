/*
 * Care Station demo — standalone client.
 *
 * Loads demo-data.json once at startup. All rendering and interactions
 * are mocked locally. No fetches to Supabase, Anthropic, or any Netlify
 * Function — this file is fully walled off from the production code path.
 */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    data: null,
    currentRoleId: 'admin',
    currentFilter: 'all',
    currentSort: 'severity',
    currentView: 'queue',
    openTaskId: null,
    feedback: {},      // taskId -> { category: 'up'|'down', response: 'up'|'down' }
    prefs: {},          // roleId -> Set(categoryIds)
    tour: { active: false, stepIndex: 0 },
  };

  // Staff member assigned to act as "current user" for a given role.
  // Admin views everything but doesn't represent a single claimer.
  const roleToStaff = {
    admin: null,
    front_desk: 's1',
    nurse: 's2',
    np: 's3',
    provider: 's4',
  };

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  async function init() {
    try {
      const resp = await fetch('demo-data.json');
      state.data = await resp.json();
    } catch (e) {
      console.error('[demo] failed to load demo-data.json', e);
      document.body.insertAdjacentHTML('beforeend',
        '<div style="padding:40px;text-align:center;color:#dc2626">' +
        'Could not load demo data. Reload the page to try again.</div>');
      return;
    }

    // Seed preferences from each role's default_categories
    state.data.roles.forEach(r => {
      if (r.default_categories === '*') {
        state.prefs[r.id] = new Set(state.data.categories.map(c => c.id));
      } else {
        state.prefs[r.id] = new Set(r.default_categories);
      }
    });

    populateRoleSelect();
    bindNav();
    bindFilters();
    bindSidePanel();
    bindWelcomeModal();
    bindTour();
    bindPreferences();
    bindTraining();

    renderAll();
    // Show welcome modal on first load.
    document.getElementById('welcomeOverlay').classList.remove('dismissed');
  }

  // ---------------------------------------------------------------------------
  // Render — orchestration
  // ---------------------------------------------------------------------------
  function renderAll() {
    renderHeader();
    renderQueue();
    renderPreferences();
    renderTraining();
  }

  function renderHeader() {
    const role = currentRole();
    const userName = document.getElementById('userName');
    const userAvatar = document.getElementById('userAvatar');
    if (state.currentRoleId === 'admin') {
      userName.textContent = 'Admin';
      userAvatar.textContent = 'A';
    } else {
      const staff = state.data.staff.find(s => s.id === roleToStaff[state.currentRoleId]);
      if (staff) {
        userName.textContent = staff.name;
        userAvatar.textContent = staff.initials;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Role select
  // ---------------------------------------------------------------------------
  function populateRoleSelect() {
    const sel = document.getElementById('roleSelect');
    sel.innerHTML = '';
    state.data.roles.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      sel.appendChild(opt);
    });
    sel.value = state.currentRoleId;
    sel.addEventListener('change', () => {
      state.currentRoleId = sel.value;
      renderAll();
    });
  }

  function currentRole() {
    return state.data.roles.find(r => r.id === state.currentRoleId);
  }

  function visibleCategoriesForRole() {
    const role = currentRole();
    const prefs = state.prefs[role.id];
    return prefs || new Set();
  }

  // ---------------------------------------------------------------------------
  // Queue rendering
  // ---------------------------------------------------------------------------
  function renderQueue() {
    const role = currentRole();
    const visibleCats = visibleCategoriesForRole();
    const subtitle = document.getElementById('queueSubtitle');

    let tasks = state.data.tasks.filter(t => {
      // Admin sees everything
      if (role.id === 'admin') return true;
      // Primary category in this role's visible set, or any secondary category
      const inPrimary = visibleCats.has(t.ai_category);
      const inSecondary = (t.ai_secondary_categories || []).some(c => visibleCats.has(c));
      return inPrimary || inSecondary;
    });

    // Apply filter pill
    const me = roleToStaff[role.id];
    if (state.currentFilter === 'unclaimed') {
      tasks = tasks.filter(t => t.status === 'unclaimed');
    } else if (state.currentFilter === 'mine') {
      tasks = tasks.filter(t => me && t.assigned_to === me);
    } else if (state.currentFilter === 'completed') {
      tasks = tasks.filter(t => t.status === 'completed');
    }

    // Sort
    const sev = state.data.severities;
    const sevRank = id => (sev.find(s => s.id === id) || { rank: 99 }).rank;
    if (state.currentSort === 'severity') {
      tasks.sort((a, b) => {
        const r = sevRank(a.ai_severity) - sevRank(b.ai_severity);
        if (r !== 0) return r;
        return new Date(b.received_at) - new Date(a.received_at);
      });
    } else if (state.currentSort === 'time_desc') {
      tasks.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    } else if (state.currentSort === 'time_asc') {
      tasks.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
    }

    // Subtitle
    if (role.id === 'admin') {
      subtitle.textContent = 'All categories · sorted by severity, then time';
    } else {
      subtitle.textContent = role.subtitle;
    }

    // Stats
    renderQueueStats(role, visibleCats);

    // Table body
    const tbody = document.getElementById('taskTableBody');
    tbody.innerHTML = '';
    document.getElementById('emptyState').classList.toggle('hidden', tasks.length > 0);
    tasks.forEach(t => tbody.appendChild(renderTaskRow(t)));
  }

  function renderQueueStats(role, visibleCats) {
    const stats = document.getElementById('queueStats');
    const me = roleToStaff[role.id];
    const visibleTasks = state.data.tasks.filter(t => {
      if (role.id === 'admin') return true;
      const inPrimary = visibleCats.has(t.ai_category);
      const inSecondary = (t.ai_secondary_categories || []).some(c => visibleCats.has(c));
      return inPrimary || inSecondary;
    });
    const urgent = visibleTasks.filter(t => t.ai_severity === 'urgent' && t.status !== 'completed').length;
    const unclaimed = visibleTasks.filter(t => t.status === 'unclaimed').length;
    const mine = me ? visibleTasks.filter(t => t.assigned_to === me && t.status !== 'completed').length : 0;

    stats.innerHTML = `
      <div class="queue-stat urgent"><div class="queue-stat-num">${urgent}</div><div class="queue-stat-label">Urgent</div></div>
      <div class="queue-stat unclaimed"><div class="queue-stat-num">${unclaimed}</div><div class="queue-stat-label">Unclaimed</div></div>
      ${me ? `<div class="queue-stat mine"><div class="queue-stat-num">${mine}</div><div class="queue-stat-label">Mine</div></div>` : ''}
    `;
  }

  function renderTaskRow(t) {
    const tr = document.createElement('tr');
    tr.className = 'task-row';
    tr.dataset.taskId = t.id;

    const sev = state.data.severities.find(s => s.id === t.ai_severity);
    const channel = state.data.channels.find(c => c.id === t.channel);
    const cat = state.data.categories.find(c => c.id === t.ai_category);

    // Secondary category badges
    const secondaryHtml = (t.ai_secondary_categories || [])
      .map(cid => {
        const sc = state.data.categories.find(c => c.id === cid);
        return sc ? `<span class="category-tag-secondary">+ ${escapeHtml(sc.name)}</span>` : '';
      })
      .join('');

    tr.innerHTML = `
      <td class="td-severity">
        <span class="severity-badge ${t.ai_severity}">
          <span class="sev-dot"></span>${escapeHtml(sev.name)}
        </span>
      </td>
      <td class="td-channel">
        <span class="channel-chip ${t.channel}">${escapeHtml(channel.symbol)}</span>
      </td>
      <td class="td-time time-cell">${formatTime(t.received_at)}</td>
      <td class="td-patient">
        <div class="patient-cell">
          <span class="patient-name">${escapeHtml(t.patient_name)}</span>
          <span class="patient-id">${escapeHtml(t.patient_id)}</span>
        </div>
      </td>
      <td class="td-category">
        <span class="category-tag ${cat.color}">${escapeHtml(cat.name)}</span>${secondaryHtml}
      </td>
      <td class="td-summary"><div class="summary-cell">${escapeHtml(t.ai_summary)}</div></td>
      <td class="td-status">${renderStatus(t)}</td>
    `;
    tr.addEventListener('click', () => openSidePanel(t.id));
    return tr;
  }

  function renderStatus(t) {
    if (t.status === 'unclaimed') {
      return '<span class="status-badge unclaimed">Unclaimed</span>';
    }
    const staff = state.data.staff.find(s => s.id === t.assigned_to);
    const initials = staff ? staff.initials : '?';
    const label = t.status === 'in_progress' ? 'In progress' :
                  t.status === 'completed' ? 'Completed' : 'Claimed';
    return `<span class="status-badge ${t.status}">${label}<span class="status-mini-avatar">${initials}</span></span>`;
  }

  // ---------------------------------------------------------------------------
  // Filter pills + sort
  // ---------------------------------------------------------------------------
  function bindFilters() {
    document.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        state.currentFilter = btn.dataset.filter;
        renderQueue();
      });
    });
    document.getElementById('sortSelect').addEventListener('change', e => {
      state.currentSort = e.target.value;
      renderQueue();
    });
  }

  // ---------------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------------
  function bindSidePanel() {
    document.getElementById('sidePanelClose').addEventListener('click', closeSidePanel);
    document.getElementById('sidePanelOverlay').addEventListener('click', closeSidePanel);
  }

  function openSidePanel(taskId) {
    const t = state.data.tasks.find(x => x.id === taskId);
    if (!t) return;
    state.openTaskId = taskId;

    const cat = state.data.categories.find(c => c.id === t.ai_category);
    const sev = state.data.severities.find(s => s.id === t.ai_severity);
    const channel = state.data.channels.find(c => c.id === t.channel);
    const fb = state.feedback[t.id] || {};

    document.getElementById('sidePanelEyebrow').textContent = `${cat.name} · ${sev.name}`;
    document.getElementById('sidePanelTitle').textContent = `${t.patient_name} · ${t.patient_id}`;

    // Linked-task note for dual messages
    const secondaryCatNames = (t.ai_secondary_categories || [])
      .map(cid => (state.data.categories.find(c => c.id === cid) || {}).name)
      .filter(Boolean);
    const linkedHtml = secondaryCatNames.length ? `
      <div class="linked-task-note">
        <strong>Linked sub-task:</strong>
        Also routed to ${secondaryCatNames.join(', ')} for follow-up.
      </div>
    ` : '';

    document.getElementById('sidePanelBody').innerHTML = `
      <div class="detail-section">
        <div class="detail-meta-row">
          <div class="detail-meta-item">
            <span class="detail-meta-key">Channel</span>
            <span class="detail-meta-val"><span class="channel-chip ${t.channel}" style="margin-right:6px">${escapeHtml(channel.symbol)}</span>${escapeHtml(channel.label)}</span>
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-key">Received</span>
            <span class="detail-meta-val">${formatDateTime(t.received_at)}</span>
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-key">Severity</span>
            <span class="detail-meta-val"><span class="severity-badge ${t.ai_severity}"><span class="sev-dot"></span>${escapeHtml(sev.name)}</span></span>
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-key">Status</span>
            <span class="detail-meta-val">${renderStatus(t)}</span>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-label">Inbound message</div>
        <div class="detail-message-box">${escapeHtml(t.message)}</div>
      </div>

      <div class="detail-section">
        <div class="detail-section-label">
          <span>AI categorization</span>
          <span class="thumb-row">
            <button class="thumb-btn up ${fb.category === 'up' ? 'active' : ''}" data-thumb="category" data-vote="up"><span class="thumb-icon">▲</span> Looks right</button>
            <button class="thumb-btn down ${fb.category === 'down' ? 'active' : ''}" data-thumb="category" data-vote="down"><span class="thumb-icon">▼</span> Wrong</button>
          </span>
        </div>
        <div class="detail-ai-box">
          <div class="detail-ai-line">
            <span class="ai-key">Primary category</span>
            <span class="ai-val"><span class="category-tag ${cat.color}">${escapeHtml(cat.name)}</span></span>
          </div>
          <div class="detail-ai-line">
            <span class="ai-key">Confidence</span>
            <span class="ai-val">
              <span class="confidence-bar">
                <span class="confidence-bar-track"><span class="confidence-bar-fill" style="width:${Math.round(t.ai_category_confidence * 100)}%"></span></span>
                ${Math.round(t.ai_category_confidence * 100)}%
              </span>
            </span>
          </div>
          ${secondaryCatNames.length ? `
            <div class="detail-ai-line">
              <span class="ai-key">Also touches</span>
              <span class="ai-val">${secondaryCatNames.map(n => `<span class="category-tag-secondary">${escapeHtml(n)}</span>`).join(' ')}</span>
            </div>
          ` : ''}
        </div>
        ${linkedHtml}
      </div>

      <div class="detail-section">
        <div class="detail-section-label">AI summary</div>
        <div class="detail-summary">${escapeHtml(t.ai_summary)}</div>
      </div>

      <div class="detail-section">
        <div class="detail-section-label">
          <span>AI-drafted response</span>
          <span class="thumb-row">
            <button class="thumb-btn up ${fb.response === 'up' ? 'active' : ''}" data-thumb="response" data-vote="up"><span class="thumb-icon">▲</span> Good</button>
            <button class="thumb-btn down ${fb.response === 'down' ? 'active' : ''}" data-thumb="response" data-vote="down"><span class="thumb-icon">▼</span> Needs work</button>
          </span>
        </div>
        <div class="detail-response">${escapeHtml(t.ai_suggested_response)}</div>
      </div>

      <div class="detail-section">
        <div class="detail-section-label">Actions</div>
        <div class="detail-actions">
          <button class="action-btn primary" data-action="send">Accept &amp; Send Response</button>
          <button class="action-btn" data-action="edit">Edit Response</button>
          <button class="action-btn" data-action="reassign">Reassign</button>
          <button class="action-btn escalate" data-action="escalate">Escalate to Provider</button>
        </div>
      </div>

      <div class="detail-toast" id="detailToast"></div>
    `;

    bindThumbs();
    bindDetailActions();

    document.getElementById('sidePanel').classList.add('active');
    document.getElementById('sidePanelOverlay').classList.add('active');
    document.getElementById('sidePanel').setAttribute('aria-hidden', 'false');
  }

  function closeSidePanel() {
    document.getElementById('sidePanel').classList.remove('active');
    document.getElementById('sidePanelOverlay').classList.remove('active');
    document.getElementById('sidePanel').setAttribute('aria-hidden', 'true');
    state.openTaskId = null;
  }

  function bindThumbs() {
    document.querySelectorAll('.thumb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const taskId = state.openTaskId;
        if (!taskId) return;
        const which = btn.dataset.thumb;
        const vote = btn.dataset.vote;
        state.feedback[taskId] = state.feedback[taskId] || {};
        // Toggle if already this vote
        if (state.feedback[taskId][which] === vote) {
          delete state.feedback[taskId][which];
        } else {
          state.feedback[taskId][which] = vote;
        }
        // Re-render thumbs only
        openSidePanel(taskId);
        showDetailToast(vote === 'up' ?
          'Thanks — the AI will see this as a correct call.' :
          'Got it — sent to training queue for review.');
      });
    });
  }

  function bindDetailActions() {
    document.querySelectorAll('.detail-actions .action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const msg = {
          send:     'Response sent to patient. Task marked complete.',
          edit:     'Opening editor… (demo placeholder)',
          reassign: 'Reassign menu would appear here.',
          escalate: 'Escalated to provider — they\'ve been pinged.',
        }[action] || '';
        showDetailToast(msg);
      });
    });
  }

  function showDetailToast(msg) {
    const toast = document.getElementById('detailToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('active');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('active'), 2400);
  }

  // ---------------------------------------------------------------------------
  // Top-bar nav (views)
  // ---------------------------------------------------------------------------
  function bindNav() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }
  function switchView(view) {
    state.currentView = view;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  }

  // ---------------------------------------------------------------------------
  // Welcome modal
  // ---------------------------------------------------------------------------
  function bindWelcomeModal() {
    document.getElementById('startTourBtn').addEventListener('click', () => {
      dismissWelcome();
      startTour();
    });
    document.getElementById('skipTourBtn').addEventListener('click', () => {
      dismissWelcome();
    });
    document.getElementById('restartTourBtn').addEventListener('click', () => {
      closeSidePanel();
      startTour();
    });
  }
  function dismissWelcome() {
    document.getElementById('welcomeOverlay').classList.add('dismissed');
  }

  // ---------------------------------------------------------------------------
  // Tour
  // ---------------------------------------------------------------------------
  const tourSteps = [
    {
      target: '#roleSwitcher',
      title: 'Switch between roles',
      body: 'Front Desk, Nurse, NP, and Provider each see a different queue. Try switching to see how the same inbox looks from each chair.',
      placement: 'bottom-end',
    },
    {
      target: '.task-table thead .th-severity',
      title: 'Sorted by severity',
      body: 'Urgent tasks float to the top. Same-day, routine, and info-only follow below.',
      placement: 'bottom',
    },
    {
      target: '.task-row[data-task-id="t001"] .td-channel',
      title: 'Every channel in one place',
      body: 'SMS, email, web forms, and voicemails (auto-transcribed) all land in the same queue.',
      placement: 'right',
    },
    {
      target: '.task-row[data-task-id="t001"] .td-category',
      title: 'AI-categorized automatically',
      body: 'The model reads each message, picks a category, and assigns it to the right person\'s queue.',
      placement: 'right',
    },
    {
      target: '.task-row[data-task-id="t017"]',
      title: 'Dual-purpose messages',
      body: 'When a message is both clinical AND scheduling/billing, the AI splits it — primary task goes to the nurse, secondary sub-task goes to the front desk.',
      placement: 'top',
      action: 'click-row',
      actionTarget: '.task-row[data-task-id="t017"]',
    },
    {
      target: '.detail-response',
      title: 'AI-drafted response',
      body: 'The AI drafts a reply in your clinic\'s voice. Staff can send as-is, edit, escalate to a provider, or reassign.',
      placement: 'left',
      waitForPanel: true,
    },
    {
      target: '.detail-actions',
      title: 'One click to act',
      body: 'Accept & Send closes the loop. Escalate routes urgent clinical concerns to the provider. Reassign hands it off.',
      placement: 'left',
    },
    {
      target: '[data-view="preferences"]',
      title: 'Each role picks its own queue',
      body: 'Open My Preferences to choose which categories of patient messages come into your queue.',
      placement: 'bottom',
    },
    {
      target: '[data-view="training"]',
      title: 'The AI learns from your team',
      body: 'Every thumbs-up or thumbs-down trains the model. Over time it matches your clinic\'s voice and judgment.',
      placement: 'bottom',
    },
    {
      target: '#tabNav',
      title: "That's the full picture",
      body: 'Click around — the demo is yours to explore. Hit "Restart tour" anytime in the demo banner.',
      placement: 'bottom',
      isFinal: true,
    },
  ];

  function bindTour() {
    document.getElementById('tourBtnNext').addEventListener('click', tourNext);
    document.getElementById('tourBtnSkip').addEventListener('click', endTour);
  }

  function startTour() {
    state.tour.active = true;
    state.tour.stepIndex = 0;
    // Force admin role so every task referenced by the tour is visible.
    state.currentRoleId = 'admin';
    document.getElementById('roleSelect').value = 'admin';
    renderAll();
    switchView('queue');
    showTourStep();
  }

  async function showTourStep() {
    const step = tourSteps[state.tour.stepIndex];
    if (!step) return endTour();

    // Special handling: some steps need to open the side panel first
    if (step.action === 'click-row' && step.actionTarget) {
      const row = document.querySelector(step.actionTarget);
      if (row) row.click();
      await wait(300);
    } else if (!step.waitForPanel && state.openTaskId && !step.target.startsWith('.detail-')) {
      // Close panel if we're moving away from detail steps
      closeSidePanel();
      await wait(220);
    } else if (step.target.startsWith('.detail-') && !state.openTaskId) {
      // We need the panel open
      const row = document.querySelector('.task-row[data-task-id="t017"]');
      if (row) row.click();
      await wait(300);
    }

    const target = document.querySelector(step.target);
    if (!target) {
      // Skip this step if target not found
      state.tour.stepIndex += 1;
      return showTourStep();
    }

    // Scroll into view if needed
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(200);

    positionTourBubble(target, step);

    document.getElementById('tourStepNum').textContent =
      `Step ${state.tour.stepIndex + 1} of ${tourSteps.length}`;
    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourBody').textContent = step.body;
    document.getElementById('tourBtnNext').textContent = step.isFinal ? 'Done' : 'Next';

    document.getElementById('tourBubble').classList.add('active');
    document.getElementById('tourSpotlight').classList.add('active');
  }

  function positionTourBubble(target, step) {
    const rect = target.getBoundingClientRect();
    const spotlight = document.getElementById('tourSpotlight');
    const pad = 8;
    spotlight.style.left = `${rect.left - pad}px`;
    spotlight.style.top = `${rect.top - pad}px`;
    spotlight.style.width = `${rect.width + pad * 2}px`;
    spotlight.style.height = `${rect.height + pad * 2}px`;

    const bubble = document.getElementById('tourBubble');
    // Make bubble briefly visible to measure
    bubble.style.visibility = 'hidden';
    bubble.classList.add('active');
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    bubble.classList.remove('active');
    bubble.style.visibility = '';

    const placement = step.placement || 'bottom';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 16;

    let top, left;
    if (placement.startsWith('bottom')) {
      top = rect.bottom + gap;
      left = placement === 'bottom-end' ? rect.right - bw : rect.left + rect.width / 2 - bw / 2;
    } else if (placement === 'top') {
      top = rect.top - bh - gap;
      left = rect.left + rect.width / 2 - bw / 2;
    } else if (placement === 'left') {
      top = rect.top + rect.height / 2 - bh / 2;
      left = rect.left - bw - gap;
    } else if (placement === 'right') {
      top = rect.top + rect.height / 2 - bh / 2;
      left = rect.right + gap;
    } else {
      top = rect.bottom + gap;
      left = rect.left;
    }

    // Clamp to viewport
    left = Math.max(16, Math.min(left, vw - bw - 16));
    top = Math.max(60, Math.min(top, vh - bh - 16));

    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
  }

  function tourNext() {
    state.tour.stepIndex += 1;
    if (state.tour.stepIndex >= tourSteps.length) return endTour();
    showTourStep();
  }

  function endTour() {
    state.tour.active = false;
    document.getElementById('tourBubble').classList.remove('active');
    document.getElementById('tourSpotlight').classList.remove('active');
    closeSidePanel();
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------
  function bindPreferences() {
    document.getElementById('prefsSaveBtn').addEventListener('click', () => {
      const note = document.getElementById('prefsSavedNote');
      note.classList.remove('hidden');
      clearTimeout(note._timer);
      note._timer = setTimeout(() => note.classList.add('hidden'), 2400);
      renderQueue();
    });
  }

  function renderPreferences() {
    const role = currentRole();
    document.getElementById('prefsRoleName').textContent = role.name;
    document.getElementById('prefsRoleDesc').textContent = role.subtitle;

    const prefs = state.prefs[role.id];
    const clinical = state.data.categories.filter(c => c.type === 'clinical');
    const nonClinical = state.data.categories.filter(c => c.type === 'non_clinical');

    const grid = (cats, mountId) => {
      const mount = document.getElementById(mountId);
      mount.innerHTML = '';
      cats.forEach(c => {
        const checked = prefs.has(c.id);
        const label = document.createElement('label');
        label.className = `pref-option ${checked ? 'checked' : ''}`;
        label.innerHTML = `
          <input type="checkbox" ${checked ? 'checked' : ''} data-cat="${c.id}">
          <span class="pref-cat-name">${escapeHtml(c.name)}</span>
          <span class="pref-cat-type">${c.type === 'clinical' ? 'Clinical' : 'Non-clinical'}</span>
        `;
        const input = label.querySelector('input');
        input.addEventListener('change', () => {
          if (input.checked) prefs.add(c.id);
          else prefs.delete(c.id);
          label.classList.toggle('checked', input.checked);
        });
        mount.appendChild(label);
      });
    };
    grid(clinical, 'prefsClinicalGrid');
    grid(nonClinical, 'prefsNonClinicalGrid');
  }

  // ---------------------------------------------------------------------------
  // Training view
  // ---------------------------------------------------------------------------
  function bindTraining() { /* tone radios are visual-only */ }

  function renderTraining() {
    const corrections = [
      { time: '14:42', by: 'Susan T.', from: 'Side Effects', to: 'Urgent Clinical', context: 'Severe pain re-categorization' },
      { time: '13:18', by: 'Patricia D.', from: 'Refill Request', to: 'Dose Question', context: 'Patient was asking about timing, not refill' },
      { time: '12:55', by: 'Jamie K.', from: 'General Inquiry', to: 'Insurance', context: 'EOB question, not general' },
      { time: '11:30', by: 'Susan T.', from: 'Routine', to: 'Same Day', context: 'Severity adjustment up' },
      { time: '10:42', by: 'Patricia D.', from: 'Side Effects', to: 'Symptom Report', context: 'Symptom not clearly med-related' },
      { time: '09:14', by: 'Jamie K.', from: 'Billing', to: 'Insurance', context: 'Coverage-specific' },
    ];
    const mount = document.getElementById('trainingList');
    mount.innerHTML = corrections.map(c => `
      <div class="training-correction">
        <div class="tc-time">Today ${c.time}</div>
        <div class="tc-from"><strong>${escapeHtml(c.from)}</strong></div>
        <div class="tc-to"><strong>${escapeHtml(c.to)}</strong> <span style="color:var(--gray-500);font-weight:400;font-size:12px">— ${escapeHtml(c.context)}</span></div>
        <div class="tc-by" title="${escapeHtml(c.by)}">${escapeHtml(c.by.split(' ').map(p => p[0]).join(''))}</div>
      </div>
    `).join('');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diffMin = Math.round((now - d) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 60 * 24) {
      const h = Math.floor(diffMin / 60);
      return `${h}h ago`;
    }
    return d.toLocaleDateString();
  }
  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
