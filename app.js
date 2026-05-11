// Relai — Triage and Tasking
// app.js — all application logic
// BASE_PROMPT and DEFAULT_KB live in data/base-prompt.js and data/default-kb.js
// (loaded as plain <script> tags before this file in index.html).

// Category lists for the Classification-card pills. Derived from
// RELAI_DEFAULTS.categories in data/defaults.js so there's one source
// of truth for category metadata. The dropdown / pill UIs read these;
// when tenant-specific overrides land in Phase 4 (per the readiness
// audit in PLAN.md), this derivation switches to the tenant's
// categories with RELAI_DEFAULTS as fallback.
//
// CLINICAL_CATS = categories where kind is 'clinical' or 'mixed'.
// NON_CLINICAL_CATS = categories where kind is 'non_clinical' or
// 'mixed'. "General Inquiry" appears in both because it's mixed —
// staff can correct an AI label to "General Inquiry" from either
// camp depending on context.
const CLINICAL_CATS = Object.keys(RELAI_DEFAULTS.categories || {})
  .filter(function(name){
    var k = RELAI_DEFAULTS.categories[name].kind;
    return k === 'clinical' || k === 'mixed';
  });
const NON_CLINICAL_CATS = Object.keys(RELAI_DEFAULTS.categories || {})
  .filter(function(name){
    var k = RELAI_DEFAULTS.categories[name].kind;
    return k === 'non_clinical' || k === 'mixed';
  });

const TIMEFRAMES = [
  {v:'routine',l:'Routine',c:'routine'},
  {v:'24h',l:'Within 24h',c:'same-day'},
  {v:'24-72h',l:'24-72 Hours',c:'same-day'},
  {v:'same-day',l:'Same Day',c:'same-day'},
  {v:'urgent',l:'URGENT',c:'urgent'},
];


let kb = JSON.parse(JSON.stringify(DEFAULT_KB));
// Auth state
let currentUser = null;      // Supabase user object
let currentProfile = null;   // Profile + company data
let currentHistoryId = null;
let triageStartTime = null;
// Cache of history rows by id (v0.3.19). Populated by loadHistory
// every time the list refreshes; consumed by toggleHistoryRowDetail
// when expanding a row inline and by deleteHistoryEntry when
// building the confirm-dialog preview. We hold the data in memory
// rather than re-fetching per-row so expand is instant. Cleared
// implicitly each loadHistory call.
let historyRowsById = {};
// Current page of the History table (v0.3.24). 1-indexed for
// display. Reset to 1 on filter/sort/page-size change (any
// user-initiated control re-renders from the top), but preserved
// across single-row deletes so staff can keep working through
// the same batch. Clamped to [1, totalPages] at render time —
// if a filter reduces the row count below the current page,
// we snap to the last valid page rather than rendering blank.
let historyCurrentPage = 1;

function getSession(){
  try{ return JSON.parse(localStorage.getItem('relai_session')||'null'); }catch(e){ return null; }
}
function getToken(){
  var s = getSession();
  return s ? s.access_token : null;
}

// Supabase public values, mirroring login.html. Both files need these
// for the magic-link flow (login.html) and the silent token-refresh
// flow (here). The anon key is intentionally exposed in client code
// — that's how Supabase is designed.
// If you ever rotate these, update BOTH login.html and this block.
const SUPA_URL = 'https://aturbsnqpdtvhrnujrqb.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0dXJic25xcGR0dmhybnVqcnFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc5MTgsImV4cCI6MjA5MzQyMzkxOH0.l7LdmI8PfFiIXa1nIwwauiWh6KnzpwhlpK5uieATsic';

// In-flight refresh promise. Multiple parallel API calls that hit 401
// simultaneously must share a single refresh attempt — otherwise they
// each rotate the refresh_token, the writes race, and only the last
// one ends up in localStorage. The dropped tokens would be invalid on
// next use, kicking the user to the login page even though we just
// fetched a new one.
let refreshInFlight = null;

// Use the stored refresh_token to mint a new access_token (and
// rotated refresh_token) from Supabase, write both back to
// localStorage. Returns true on success, false if no refresh_token,
// the call failed, or Supabase returned an error.
async function refreshSupabaseToken(){
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async function(){
    try {
      var session = getSession();
      if (!session || !session.refresh_token) return false;
      var r = await fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPA_KEY,
        },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!r.ok) {
        console.error('refreshSupabaseToken: status', r.status);
        return false;
      }
      var data = await r.json();
      if (!data || !data.access_token) return false;
      localStorage.setItem('relai_session', JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token || session.refresh_token,
        timestamp: Date.now(),
      }));
      return true;
    } catch (e) {
      console.error('refreshSupabaseToken:', e.message);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// Bearer-token-attaching fetch with automatic refresh-on-401-retry.
// Every authenticated network call in the app should route through
// this. The flow:
//   1. Send the request with the current access_token.
//   2. If response is 401, try to refresh the access_token using the
//      stored refresh_token.
//   3. If refresh succeeds, retry the request once with the new token.
//   4. If refresh fails AND we had a session to begin with, the
//      session is dead — show a toast and redirect to /login.html.
//      (No infinite retry loop.)
// Returns the Response object; the caller handles parsing.
async function authFetch(url, opts){
  opts = opts || {};
  var baseHeaders = Object.assign({}, opts.headers || {});

  var doFetch = function(tok){
    var hdrs = Object.assign({}, baseHeaders);
    if (tok) hdrs['Authorization'] = 'Bearer ' + tok;
    return fetch(url, Object.assign({}, opts, { headers: hdrs }));
  };

  var r = await doFetch(getToken());
  if (r.status !== 401) return r;

  var refreshed = await refreshSupabaseToken();
  if (refreshed) {
    return await doFetch(getToken());
  }

  // Refresh failed. If we had a session at all, it's dead — surface
  // it to the user briefly, then redirect. Don't redirect synchronously
  // because the caller's catch block needs to run first.
  if (getSession()) {
    try { showToast('Session expired — redirecting to login...', 'warn'); } catch(e) {}
    setTimeout(function(){
      localStorage.removeItem('relai_session');
      window.location.href = '/login.html';
    }, 1500);
  }
  return r;
}
function getCompanyId(){
  // currentProfile.company_id comes straight from the `profiles`
  // table (see auth.js — its `select` includes company_id). The old
  // implementation looked under `company_members` which is never
  // populated because auth.js does no joins (joins fail when the
  // membership row is absent), so getCompanyId() always returned
  // null and every triage row was written with company_id = NULL.
  // The cost/quality endpoints' user-id fallback masked the bug
  // until tenant-scoped aggregations broke.
  return currentProfile && currentProfile.company_id ? currentProfile.company_id : null;
}
function getUserId(){
  return currentUser ? currentUser.id : null;
}



// Cache for KB section strings -- rebuilt only when KB changes
var kbCache = {};

function getKBSection(section, label){
  if(!kb[section]||!kb[section].length) return '';
  if(!kbCache[section]){
    kbCache[section] = '=== '+label+' ===\n'+kb[section].map(function(e){
      return '['+e.name+']\n'+e.text;
    }).join('\n\n');
  }
  return kbCache[section];
}

function invalidateKBCache(){ kbCache = {}; kbVersionCache = null; }

// Version stamps written onto every triage row. They let us answer
// "which prompt/KB produced this?" when looking at quality trends —
// regressions can then be attributed to a specific version instead of
// guessed at. simpleHash() is defined in data/triage-lib.js.
//
// IMPORTANT: hash BASE_PROMPT_TEMPLATE, NOT BASE_PROMPT. The rendered
// prompt has today's date substituted in, so hashing it would
// change the prompt_version every day even with no actual prompt
// change — defeating the whole point of version stamping.
var promptVersionCache = null;
var kbVersionCache = null;
function getPromptVersion(){
  if(promptVersionCache) return promptVersionCache;
  if(typeof BASE_PROMPT_TEMPLATE === 'undefined') return null;
  promptVersionCache = simpleHash(BASE_PROMPT_TEMPLATE);
  return promptVersionCache;
}
function getKBVersion(){
  if(kbVersionCache) return kbVersionCache;
  kbVersionCache = simpleHash(getFullKB());
  return kbVersionCache;
}

// parseTriageJSON / computeUrgencyScore / formatDuration /
// levenshteinDistance / simpleHash / computeTriageCost are defined
// in data/triage-lib.js so they can be unit-tested in Node. Browser
// sees them as globals.

// Build the full KB string (every section, in stable order). Used as the
// second cache block in runTriage so Anthropic prompt caching can hit on
// every warm call. Stable key = stable cache. Section order + labels
// come from RELAI_DEFAULTS.kb_sections so eval/run.js renders the
// same shape — drift between the two would make eval kb_version hashes
// differ from what production stamps on triage rows.
function getFullKB(){
  return (RELAI_DEFAULTS.kb_sections || [])
    .map(function(s){ return getKBSection(s.key, s.label); })
    .filter(Boolean).join('\n\n');
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function initAuth(){
  // Step 1: if magic link token arrived in URL hash, save it first
  var hash = window.location.hash;
  if(hash && hash.includes('access_token')){
    var p = new URLSearchParams(hash.replace('#',''));
    var token = p.get('access_token');
    var refresh = p.get('refresh_token');
    if(token){
      localStorage.setItem('relai_session', JSON.stringify({
        access_token: token,
        refresh_token: refresh || '',
        timestamp: Date.now()
      }));
      history.replaceState(null, '', window.location.pathname);
    }
  }

  // Step 2: check session
  var session = getSession();
  if(!session || !session.access_token){
    window.location.href = '/login.html';
    return;
  }
  try{
    // authFetch (v0.3.12) auto-refreshes a stale JWT on 401. If we
    // get here after the user's been gone >1 hour, the original
    // access_token is dead; the silent refresh keeps them logged
    // in without bouncing through the magic-link flow.
    var r = await authFetch('/.netlify/functions/auth/profile', {
      headers: {'Content-Type': 'application/json'},
    });
    var data = await r.json();
    if(!data.user || !data.user.id){
      localStorage.removeItem('relai_session');
      window.location.href = '/login.html';
      return;
    }
    currentUser = data.user;
    currentProfile = data.profile;
    // Set chip
    var name = (currentProfile&&currentProfile.full_name) || currentUser.email.split('@')[0];
    var initials = name.split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
    var chipEl = document.getElementById('staffChipName');
    var avatarEl = document.getElementById('chipAvatar');
      if(chipEl) chipEl.textContent = name.split(' ')[0]; // first name only
    if(avatarEl) avatarEl.textContent = initials;
    // Update topbar tenant label from tenant config (falls back to defaults).
    var brandTenantEl = document.getElementById('brandTenant');
    if(brandTenantEl){
      var tenantName = (currentProfile && currentProfile.company_name)
        || tenantValue(currentProfile && currentProfile.tenant, 'brand.name');
      brandTenantEl.textContent = tenantName;
    }
    // Store name and department globally
    var dept = (currentProfile&&currentProfile.role)||'';
    window.currentNurse = name;
    window.currentDepartment = dept;
    // Show dept badge on chip
    var deptBadge = document.getElementById('staffDeptBadge');
    if(deptBadge){
      if(dept==='Clinical'){
        deptBadge.textContent='RN';
        deptBadge.style.display='';
        deptBadge.style.background='var(--blue-m)';
        deptBadge.style.color='var(--blue)';
        if(avatarEl) avatarEl.style.background='var(--blue)';
      } else if(dept==='Non-Clinical'){
        deptBadge.textContent='CS';
        deptBadge.style.display='';
        deptBadge.style.background='var(--amber-l)';
        deptBadge.style.color='var(--amber)';
        if(avatarEl) avatarEl.style.background='var(--amber)';
      }
    }
  }catch(e){
    console.error('initAuth:', e.message);
    // Network error — don't redirect, allow offline use
    window.currentNurse = 'Staff';
    var chipEl = document.getElementById('staffChipName');
    if(chipEl) chipEl.textContent = 'Offline';
  }
}


function openProfile(){
  if(!currentUser) return;
  var name = (currentProfile&&currentProfile.full_name)||currentUser.email.split('@')[0];
  var initials = name.split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
  var email = currentUser.email||'';
  var role = (currentProfile&&currentProfile.role)||'staff';
  // Format role for display: 'Clinical' or 'Non-Clinical' with department context
  var roleLabel = role==='Clinical'?'Clinical Staff (RN)':role==='Non-Clinical'?'Non-Clinical Staff':role.charAt(0).toUpperCase()+role.slice(1);
  var company = (currentProfile && currentProfile.company_name)
    || tenantValue(currentProfile && currentProfile.tenant, 'brand.name');
  document.getElementById('profileAvatar').textContent = initials;
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileEmail').textContent = email;
  document.getElementById('profileRole').textContent = roleLabel;
  document.getElementById('profileCompany').textContent = company;
  // Show a placeholder while the real numbers load from the DB. These
  // persist across logouts/magic-link refreshes — they're not session-scoped.
  document.getElementById('profileStats').textContent = 'Loading triage stats…';
  document.getElementById('profilePanel').classList.add('show');
  document.getElementById('profileOverlay').classList.add('show');
  loadProfileStats();
}

async function loadProfileStats(){
  var el = document.getElementById('profileStats');
  if(!el) return;
  try{
    var s = await api('/history/stats');
    if(s && typeof s === 'object' && (s.today != null || s.total != null)){
      el.innerHTML =
        '<div>Triages today: <strong>' + (s.today||0) + '</strong></div>' +
        '<div>Last 7 days: <strong>' + (s.week||0) + '</strong></div>' +
        '<div>All time: <strong>' + (s.total||0) + '</strong></div>';
    } else {
      el.textContent = 'Triage stats unavailable';
    }
  }catch(e){
    console.error('loadProfileStats:', e.message);
    el.textContent = 'Triage stats unavailable';
  }
}

function closeProfile(){
  document.getElementById('profilePanel').classList.remove('show');
  document.getElementById('profileOverlay').classList.remove('show');
}

function openHelpFromProfile(){
  closeProfile();
  // Find and click help tab
  var tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(function(t){
    if(t.textContent.includes('Help')){
      t.click();
    }
  });
}

async function signOut(){
  var token = getToken();
  if(token){
    try{
      await fetch('/.netlify/functions/auth/signout',{
        method:'POST',
        headers:{'Authorization':'Bearer '+token}
      });
    }catch(e){
      // Best-effort signout. Network failure is OK — we proceed to
      // clear the session and redirect regardless. Logged for debug.
      console.error('signOut.fetch:', e.message);
    }
  }
  localStorage.removeItem('relai_session');
  window.location.href = '/login.html';
}


async function api(endpoint, method, body){
  // Auth-aware wrapper for /.netlify/functions/kb* calls. Throws on
  // any non-2xx response so callers' existing try/catch blocks
  // surface real errors instead of silently treating an error body
  // as a successful response. Earlier this function did
  //   return r.json().catch(function(){return{};});
  // which collapsed three different failure modes into "looks like a
  // success with an empty/error-shaped body":
  //   - Server returned 4xx/5xx with `{error: "..."}` → callers
  //     showing "Saved" toasts on the way to data loss.
  //   - Server returned non-JSON (HTML error page, empty body) →
  //     callers seeing `{}` and continuing.
  //   - Network blip → fetch threw, no context.
  // Now: every non-2xx and every parse-failure-with-error-status
  // throws a structured Error with `.status` and `.body` attached.
  // Every existing caller is already wrapped in try/catch (verified
  // pass v0.3.8); their catch blocks now fire on real failures
  // instead of having to inspect the response shape.
  //
  // Auth: routes through authFetch (v0.3.12), which auto-refreshes
  // the access_token on 401 and retries once. Before v0.3.12, a
  // 1-hour-stale JWT would surface as a 401 here every call until
  // the user manually logged out and back in. Now the refresh
  // happens transparently.
  var opts = {
    method: method || 'GET',
    headers: {'Content-Type': 'application/json'},
  };
  if (body) opts.body = JSON.stringify(body);

  var r;
  try {
    r = await authFetch('/.netlify/functions/kb' + endpoint, opts);
  } catch (networkErr) {
    var ne = new Error('Network error reaching ' + endpoint + ': ' + networkErr.message);
    ne.cause = 'network';
    throw ne;
  }

  // Parse defensively — a 204 No Content has no body, and some
  // legitimate responses (DELETE with return=minimal) are empty.
  var parsedBody = null;
  var rawText = await r.text();
  if (rawText) {
    try { parsedBody = JSON.parse(rawText); }
    catch (parseErr) {
      if (!r.ok) {
        var pe = new Error('API ' + endpoint + ' returned ' + r.status + ' with non-JSON body: ' + rawText.slice(0, 200));
        pe.status = r.status;
        throw pe;
      }
      // OK with non-JSON body — caller might be intentionally
      // returning text. Surface as a string wrapped in {raw: ...}.
      return { raw: rawText };
    }
  }

  if (!r.ok) {
    var serverMsg = parsedBody && (parsedBody.error || parsedBody.message);
    var msg = serverMsg
      ? ('API ' + endpoint + ' returned ' + r.status + ': ' + serverMsg)
      : ('API ' + endpoint + ' returned ' + r.status);
    var err = new Error(msg);
    err.status = r.status;
    err.body = parsedBody;
    throw err;
  }

  return parsedBody == null ? {} : parsedBody;
}

async function loadKBFromServer(){
  try{
    setSyncBar('','Loading...');
    var rows=await api('/kb');
    // Three distinct cases — DON'T conflate them, the conflation is
    // a KB-wipe risk:
    //   1. rows is a non-empty array → load it.
    //   2. rows is an empty array → genuinely empty DB → seed.
    //   3. rows is anything else (an error object, malformed
    //      response, server hiccup, expired session) → DO NOT seed.
    //      Earlier code's `if(Array.isArray(rows)&&rows.length>0)
    //      else` collapsed cases 2 and 3, meaning a transient
    //      PostgREST 5xx would trigger saveKBSilent — which calls
    //      POST /kb with the in-memory seed kb and the backend
    //      DELETE-then-INSERTs it. Result: tenant's KB gets
    //      overwritten with the default seed. Total KB loss from a
    //      single hiccup. Now we explicitly check for the empty-
    //      array case and treat anything else as an error.
    if (Array.isArray(rows) && rows.length > 0) {
      var nkb={sideeffects:[],templates:[],protocols:[],urls:[],routing:[],notes:[]};
      rows.forEach(function(row){
        var s = nkb[row.section] ? row.section : 'notes';
        nkb[s].push({name:row.name,text:row.content,nurse_name:row.nurse_name||'Unknown'});
      });
      kb=nkb; invalidateKBCache();
      setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
      renderKB();
    } else if (Array.isArray(rows) && rows.length === 0) {
      // Genuinely empty — seed.
      setSyncBar('','First run -- seeding knowledge base...');
      await saveKBSilent();
      setSyncBar('synced','Knowledge base seeded . '+new Date().toLocaleTimeString());
      renderKB();
    } else {
      // Error response or malformed payload. Don't touch the DB —
      // the user's KB might be intact and the GET might just be
      // having a moment. Show the locally-cached KB and surface
      // the issue so the user knows not to trust what they see
      // until the sync resolves.
      console.error('loadKBFromServer: non-array response', rows && rows.error);
      setSyncBar('error','Could not load KB -- showing local cache. Refresh in a moment.');
      renderKB();
    }
  }catch(e){
    console.error('loadKBFromServer:', e.message);
    setSyncBar('error','Could not load -- using local defaults');
    renderKB();
  }
}

function syncKBFromDOM(){
  document.querySelectorAll('.kb-entry-content').forEach(function(ta){
    var s=ta.getAttribute('data-section'),i=parseInt(ta.getAttribute('data-index'));
    if(kb[s]&&kb[s][i]!==undefined)kb[s][i].text=ta.value;
  });
  document.querySelectorAll('.kb-entry-name').forEach(function(inp){
    var s=inp.getAttribute('data-section'),i=parseInt(inp.getAttribute('data-index'));
    if(kb[s]&&kb[s][i]!==undefined)kb[s][i].name=inp.value;
  });
}

function buildEntries(){
  // Build the payload the /kb POST handler will INSERT after it
  // DELETEs the tenant's existing rows. CRITICAL: every entry must
  // carry company_id, otherwise the inserted rows are orphaned —
  // the next /kb GET (which scopes by company_id=eq.<theirs>) won't
  // find them, and the frontend will think the DB is empty and
  // re-seed. Every Save & Sync was silently writing tenant-orphaned
  // rows until this was fixed.
  var companyId = getCompanyId();
  var userId = getUserId();
  var entries=[],pos=0;
  ['sideeffects','templates','protocols','urls','routing','notes'].forEach(function(section){
    (kb[section]||[]).forEach(function(entry){
      var row = {
        section: section,
        name: entry.name,
        content: entry.text,
        position: pos++,
        nurse_name: entry.nurse_name || window.currentNurse || 'Unknown',
        updated_at: new Date().toISOString(),
      };
      if (companyId) row.company_id = companyId;
      if (userId)    row.user_id    = userId;
      entries.push(row);
    });
  });
  return entries;
}

async function saveKBSilent(){
  syncKBFromDOM();
  await api('/kb','POST',{entries:buildEntries()});
}

async function submitEntry(){
  var title=document.getElementById('entryTitle').value.trim();
  var content=document.getElementById('entryContent').value.trim();
  var section=document.getElementById('entrySection').value;
  if(!title||!content){alert('Please enter both a title and content.');return;}
  var btn=document.getElementById('entrySubmitBtn'),txt=document.getElementById('entrySubmitTxt'),spin=document.getElementById('entrySpinner');
  btn.disabled=true;txt.textContent='Saving...';spin.className='spinner active';
  try{
    if(!kb[section])kb[section]=[];
    kb[section].push({name:title,text:content,nurse_name:window.currentNurse||(currentProfile&&currentProfile.full_name)||"Staff"}); invalidateKBCache();
    await saveKBSilent();
    document.getElementById('entryTitle').value='';
    document.getElementById('entryContent').value='';
    renderKB();showToast('Saved and synced');
  }catch(e){
    console.error('submitEntry:', e.message);
    alert('Error: '+e.message);
  }
  finally{btn.disabled=false;txt.textContent='Save & Sync to Team';spin.className='spinner';}
}

async function saveKB(){
  syncKBFromDOM();
  var btn=document.getElementById('kbSaveBtn'),txt=document.getElementById('kbSaveTxt'),spin=document.getElementById('kbSpinner');
  btn.disabled=true;txt.textContent='Syncing...';spin.className='kb-spinner active';
  try{
    await api('/kb','POST',{entries:buildEntries()}); invalidateKBCache();
    setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
    showToast('Knowledge base synced');
  }catch(e){
    console.error('saveKB:', e.message);
    setSyncBar('error','Sync failed');
  }
  finally{btn.disabled=false;txt.textContent='Save & Sync to Team';spin.className='kb-spinner';}
}


async function saveHistoryRecord(parsed,msg,telemetry){
  var userName = (currentProfile&&currentProfile.full_name)||(currentUser&&currentUser.email)||window.currentNurse||'Staff';
  var userId = getUserId();
  var companyId = getCompanyId();
  if(!userName) return null;
  try{
    var hasSE = parsed.clinical_routing_flag && (parsed.clinical_routing_level||'none')!=='none';
    var score = computeUrgencyScore(parsed.urgency, parsed.clinical_routing_level||'none', hasSE);
    var payload={nurse_name:userName,patient_message:msg,
      clinical_category:parsed.clinical_category,urgency_original:parsed.urgency,urgency_override:null,
      urgency_score:score,
      clinical_routing_level:parsed.clinical_routing_level||'none',
      routed_to:parsed.routed_to||null,
      non_clinical_flag:parsed.non_clinical_flag,non_clinical_items:parsed.non_clinical_items||[],
      follow_up_questions:parsed.follow_up_questions||[],
      draft_response:parsed.draft_response||'',
      // Persist the AI's routing recommendation. Without this, the
      // recommendation disappears the moment the staff navigates
      // away — we lose the ability to audit, eval, or learn from
      // it. Migration 0007 adds the column. Schema-tolerant: if
      // 0007 hasn't been applied yet, PostgREST drops the
      // unrecognized field rather than failing the insert (the rest
      // of the row still saves).
      internal_note: parsed.internal_note || null
    };
    if(userId) payload.user_id=userId;
    if(companyId) payload.company_id=companyId;
    // Persist the telemetry envelope onto the row. Only set columns
    // when we actually have a value — keeps NULLs in the DB instead
    // of zeros that would skew aggregations later.
    if(telemetry && typeof telemetry === 'object'){
      if(telemetry.model)                              payload.model = telemetry.model;
      if(telemetry.prompt_version)                     payload.prompt_version = telemetry.prompt_version;
      if(telemetry.kb_version)                         payload.kb_version = telemetry.kb_version;
      if(telemetry.input_tokens != null)               payload.input_tokens = telemetry.input_tokens;
      if(telemetry.output_tokens != null)              payload.output_tokens = telemetry.output_tokens;
      if(telemetry.cache_creation_tokens != null)      payload.cache_creation_tokens = telemetry.cache_creation_tokens;
      if(telemetry.cache_read_tokens != null)          payload.cache_read_tokens = telemetry.cache_read_tokens;
      if(telemetry.latency_ms != null)                 payload.latency_ms = telemetry.latency_ms;
      if(telemetry.cost_usd != null)                   payload.cost_usd = telemetry.cost_usd;
      if(telemetry.ai_confidence != null)              payload.ai_confidence = telemetry.ai_confidence;
    }
    var r=await api('/history','POST',payload);
    triageStartTime = Date.now();
    window._sessionTriages = (window._sessionTriages||0) + 1;
    return Array.isArray(r)&&r[0]?r[0].id:null;
  }catch(e){
    console.error('saveHistoryRecord:', e.message);
    return null;
  }
}

// KB UI
function setSyncBar(state,msg){
  var bar=document.getElementById('syncBar');if(!bar)return;
  bar.className='kb-sync-bar'+(state?' '+state:'');
  var sm=document.getElementById('syncMsg');if(sm)sm.textContent=msg;
}
function renderKB(){
  // Only render if KB tab elements exist in DOM
  if(!document.getElementById('protocols-list'))return;
  ['sideeffects','templates','protocols','urls','routing','notes'].forEach(function(section){
    var list=document.getElementById(section+'-list');
    if(!list)return;
    list.innerHTML='';
    var items=kb[section]||[];
    var cnt=document.getElementById('cnt-'+section);
    if(cnt)cnt.textContent=items.length||'';
    if(!items.length){list.innerHTML='<div class="empty-state">No entries yet. Add one above.</div>';return;}
    items.forEach(function(entry,i){list.appendChild(makeEntryEl(section,i,entry));});
  });
}
function makeEntryEl(section,i,entry){
  var div=document.createElement('div');
  div.className='kb-entry';
  var nm=(entry.name||'');
  var isRule=nm.includes('RULES')||nm.includes('CLASSIFICATION')||nm.includes('FRAMEWORK');
  if(isRule)div.classList.add('kb-entry-collapsed');

  var header=document.createElement('div');header.className='kb-entry-header';

  var nameInp=document.createElement('input');
  nameInp.className='kb-entry-name';nameInp.type='text';nameInp.value=nm;
  nameInp.setAttribute('data-section',section);nameInp.setAttribute('data-index',i);
  nameInp.placeholder='Entry name...';

  var toggleBtn=document.createElement('button');
  toggleBtn.className='kb-entry-toggle';
  toggleBtn.textContent=isRule?'expand':'collapse';
  toggleBtn.addEventListener('click',function(){toggleKBEntry(toggleBtn,div);});

  var author=document.createElement('span');
  author.className='kb-entry-author';
  author.textContent=entry.nurse_name||'Unknown';

  header.appendChild(nameInp);header.appendChild(toggleBtn);header.appendChild(author);

  var ta=document.createElement('textarea');
  ta.className='kb-entry-content';
  ta.setAttribute('data-section',section);ta.setAttribute('data-index',i);
  ta.value=entry.text||'';

  var footer=document.createElement('div');footer.className='kb-entry-footer';

  var saveBtn=document.createElement('button');
  saveBtn.className='btn-xs save';saveBtn.textContent='Save';
  saveBtn.addEventListener('click',function(){saveEntryInline(section,i,saveBtn);});

  var delBtn=document.createElement('button');
  delBtn.className='btn-xs danger';delBtn.textContent='Delete';
  delBtn.addEventListener('click',function(){removeEntry(section,i);});

  footer.appendChild(saveBtn);footer.appendChild(delBtn);
  div.appendChild(header);div.appendChild(ta);div.appendChild(footer);
  return div;
}
async function saveEntryInline(section,i,btn){
  syncKBFromDOM();
  if(window.currentNurse&&kb[section]&&kb[section][i])kb[section][i].nurse_name=window.currentNurse;
  btn.textContent='Saving...';btn.disabled=true;
  try{
    await saveKBSilent();
    btn.textContent='Saved';btn.className='btn-xs saved';
    setTimeout(function(){btn.textContent='Save';btn.className='btn-xs save';btn.disabled=false;},2000);
    setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
    renderKB();
  }catch(e){
    console.error('saveEntryInline:', e.message);
    btn.textContent='Save';
    btn.disabled=false;
  }
}
function removeEntry(section,i){if(!confirm('Delete this entry?'))return;kb[section].splice(i,1);renderKB();}
function exportKB(){
  var blob=new Blob([JSON.stringify({kb:kb},null,2)],{type:'application/json'});
  var stamp = new Date().toISOString().slice(0,10);
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='kb-backup-'+stamp+'.json';a.click();}
function importKB(e){
  var file=e.target.files[0];if(!file)return;
  var reader=new FileReader();
  reader.onload=function(ev){
    try{var data=JSON.parse(ev.target.result);if(data.kb)kb=data.kb;renderKB();setSyncBar('','Imported -- save to sync');}
    catch(err){alert('Invalid backup file.');}
  };
  reader.readAsText(file);
}

// TABS
function togglePrior(){
  var panel = document.getElementById('priorContextPanel');
  var btn = document.getElementById('priorToggle');
  var wasOpen = panel.classList.contains('show');
  panel.classList.toggle('show');
  var nowOpen = !wasOpen;
  btn.textContent = nowOpen ? 'Remove Context' : 'Add Prior Context';
  btn.style.borderColor = nowOpen ? 'var(--blue-m)' : 'var(--gray-200)';
  btn.style.color = nowOpen ? 'var(--blue)' : 'var(--gray-500)';
  btn.style.background = nowOpen ? 'var(--blue-l)' : 'none';
  // On close, reset the turn list back to a single empty row.
  // (Same intent as the old textarea-clear behavior — don't carry
  // stale context into the next triage. Old behavior was
  // `priorInput.value = ''`; the structured equivalent is "drop
  // everything, leave one empty starter row" so the feature
  // stays discoverable when the panel reopens.)
  if(!nowOpen) resetPriorTurns();
  document.getElementById('msgLabel').textContent = nowOpen ? 'Latest Reply' : 'Current Message';
}

// ── Prior-context turn helpers (v0.3.17) ──────────────────────────
//
// Prior context used to be a free-form textarea where staff would
// type something like:
//     Patient: "..."
//     Nurse: "..."
// We learned two things from that: (1) staff don't reliably use
// that format unless told to — and teaching format is friction
// they'll skip; (2) the AI parses turn-labeled transcripts well
// when staff DO use it, so the right move is to bake the structure
// into the UI rather than leave it as a convention.
//
// Each turn row is: speaker <select> + text <textarea> + remove
// button. serializePriorTurns walks rows top-to-bottom (oldest
// first) and produces a Patient: "..." / Nurse: "..." transcript
// — the same shape the AI was already happy with. This also sets
// up channel adapters (Intercom, email, Healthie) where the data
// arrives already turn-structured: those adapters can populate
// the same row list, so manual and channel-fed prior context
// share one serialization path.

// Build one empty <div class="prior-turn"> row. Returns the
// element so callers can append where needed.
function buildPriorTurnRow(){
  var row = document.createElement('div');
  row.className = 'prior-turn';
  row.innerHTML = '<select class="prior-turn-speaker" aria-label="Speaker">'
    + '<option value="Patient">Patient</option>'
    + '<option value="Nurse">Nurse</option>'
    + '<option value="Other">Other</option>'
    + '</select>'
    + '<textarea class="prior-turn-text" placeholder="What was said..."></textarea>'
    + '<button type="button" class="prior-turn-remove" onclick="removePriorTurn(this)" aria-label="Remove turn">&times;</button>';
  return row;
}

function addPriorTurn(){
  var list = document.getElementById('priorTurnsList');
  if(!list) return;
  list.appendChild(buildPriorTurnRow());
}

function removePriorTurn(btn){
  var row = btn && btn.closest ? btn.closest('.prior-turn') : null;
  if(!row) return;
  var list = document.getElementById('priorTurnsList');
  if(!list) return;
  row.parentNode.removeChild(row);
  // Never leave the user with zero rows — the feature would
  // visually disappear and they'd have to click "Add turn" to get
  // anything back. Auto-restore one empty row if they removed the
  // last one.
  if(list.children.length === 0) list.appendChild(buildPriorTurnRow());
}

function resetPriorTurns(){
  var list = document.getElementById('priorTurnsList');
  if(!list) return;
  list.innerHTML = '';
  list.appendChild(buildPriorTurnRow());
}

// Walk turn rows top-to-bottom (chronological — oldest first) and
// produce the transcript string. Empty rows are skipped, not
// turned into empty quoted strings, so a half-filled list still
// produces a clean transcript. Returns '' if every row is empty
// (which lets runTriage take the no-prior path).
function serializePriorTurns(){
  var list = document.getElementById('priorTurnsList');
  if(!list) return '';
  var lines = [];
  var rows = list.querySelectorAll('.prior-turn');
  for(var i = 0; i < rows.length; i++){
    var sel = rows[i].querySelector('.prior-turn-speaker');
    var txt = rows[i].querySelector('.prior-turn-text');
    var speaker = sel ? sel.value : 'Patient';
    var content = txt ? (txt.value || '').trim() : '';
    if(!content) continue;
    lines.push(speaker + ': "' + content + '"');
  }
  return lines.join('\n');
}

function switchKBTab(section, btn){
  document.querySelectorAll('.kb-tab').forEach(function(b){b.classList.remove('active');});
  document.querySelectorAll('.kb-tab-panel').forEach(function(p){p.classList.remove('active');});
  btn.classList.add('active');
  var panel = document.getElementById('kb-tab-'+section);
  if(panel) panel.classList.add('active');
  document.getElementById('kbSearch').value = '';
}

function filterKBEntries(){
  var q = document.getElementById('kbSearch').value.toLowerCase().trim();
  document.querySelectorAll('.kb-entry').forEach(function(entry){
    var name = (entry.querySelector('.kb-entry-name')||{}).value||'';
    var text = (entry.querySelector('.kb-entry-content')||{}).value||'';
    var match = !q || name.toLowerCase().includes(q) || text.toLowerCase().includes(q);
    entry.style.display = match ? '' : 'none';
  });
}

function toggleKBEntry(btn, entryEl){
  entryEl.classList.toggle('kb-entry-collapsed');
  btn.textContent = entryEl.classList.contains('kb-entry-collapsed') ? 'v expand' : '^ collapse';
}

function toggleFaq(btn){
  var isOpen = btn.classList.contains('open');
  // Close all open FAQs in the same section
  var section = btn.closest('.help-section');
  if(section){
    section.querySelectorAll('.help-faq-q.open').forEach(function(b){
      b.classList.remove('open');
      var a = b.nextElementSibling;
      if(a) a.classList.remove('open');
    });
  }
  // Toggle clicked one (unless it was already open)
  if(!isOpen){
    btn.classList.add('open');
    var ans = btn.nextElementSibling;
    if(ans) ans.classList.add('open');
  }
}

function switchTab(name,btn){
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  document.getElementById('tab-'+name).classList.add('active');
  btn.classList.add('active');
  if(name==='kb')loadKBFromServer();
  if(name==='history')loadReviews();
}

// TRIAGE
function setLoading(on){
  document.getElementById('btnText').textContent=on?'Analyzing...':'Run Triage';
  document.getElementById('btnSpinner').className=on?'spinner active':'spinner';
  document.getElementById('triageBtn').disabled=on;
}

async function runTriage(){
  var msg=document.getElementById('msgInput').value.trim();
  if(!msg)return;
  setLoading(true);
currentHistoryId=null;
  document.getElementById('results').innerHTML='<div class="placeholder"><div class="spinner active" style="width:26px;height:26px;border-color:var(--gray-300);border-top-color:var(--blue);"></div><div class="placeholder-text" style="margin-top:14px;">Analyzing message...</div></div>';
    // Build user content -- include prior conversation if provided.
  //
  // The wrapper wording is deliberately strong about HOW to use the
  // prior context. Earlier the wrapper said "for background only, do
  // not respond to this directly" — the AI interpreted that as
  // "ignore the content entirely" and the new response read as if
  // no prior context had been sent. Staff reported running the same
  // triage with and without context and getting indistinguishable
  // output. Now the wrapper tells the AI explicitly: don't repeat
  // education the patient already received, and reference specific
  // facts they shared (dose, TDEE, weight goals, symptom timing).
  // BASE_PROMPT_TEMPLATE was also updated to reinforce the same
  // instruction in the draft_response section.
  // v0.3.17 — prior context is now a structured list of turns
  // (speaker dropdown + text per row) rather than a free-form
  // textarea. serializePriorTurns walks the rows top-to-bottom
  // (chronological — oldest first) and produces the same
  // Patient: "..." / Nurse: "..." transcript the AI was already
  // parsing happily. Empty rows are skipped. If no row has text,
  // prior = '' and the no-prior path runs.
  var prior = serializePriorTurns();
  // Helpful for diagnostics: console-log how much prior context made
  // it into the call. Lets staff verify in dev tools that the prior
  // context they typed actually went through.
  console.log('runTriage:', prior ? ('prior context = ' + prior.length + ' chars') : 'no prior context');
  var userContent = prior
    ? 'PRIOR CONVERSATION (earlier messages in this thread — use as context. The patient already received any information stated here, so do not repeat education they already got. Reference specific facts they shared (dose, TDEE, weight goals, symptom timing, prior side effects) when relevant to your response):\n\n'
      + prior
      + '\n\n---\n\nLATEST PATIENT MESSAGE (this is the message you are triaging and drafting a response to now — tailor your reply to what they are asking right now, drawing on the prior conversation when relevant):\n\n'
      + msg
    : msg;

  try{
    // System prompt is split into two cache breakpoints so Anthropic
    // prompt caching actually hits on warm calls. The first block is the
    // base prompt (rarely changes); the second is the full KB (changes
    // only when staff edit it). Both stay stable across triages, so the
    // cache hits ~95% of the time during a busy session and reads cost
    // 10% of input price. Sending the full KB instead of a per-message
    // classified subset is also a small accuracy win — the AI has every
    // protocol available, not a regex-selected slice.
    var systemBlocks = [
      { type:'text', text: BASE_PROMPT, cache_control:{type:'ephemeral'} },
      { type:'text', text: getFullKB(), cache_control:{type:'ephemeral'} }
    ];
    var triageStarted = Date.now();
    // authFetch auto-attaches the Bearer token AND auto-refreshes
    // on 401 (v0.3.12). Earlier this was a raw fetch with manual
    // token plumbing — a stale token would 401, throw, and the
    // user would see a generic "triage could not complete" error
    // with no way to recover other than logging out.
    var res = await authFetch('/.netlify/functions/triage', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-6',max_tokens:600,system:systemBlocks,messages:[{role:'user',content:userContent}]})
    });
    var data=await res.json();
    if(data.error)throw new Error(typeof data.error==='string'?data.error:(data.error.message||JSON.stringify(data.error)));
    var raw=(data.content||[]).map(function(b){return b.text||'';}).join('');
    if(!raw)throw new Error('Empty response from API.');
    var parsed = parseTriageJSON(raw);
    // Normalize enum drift before anything downstream looks at the
    // parsed output. Without this, an AI returning 'URGENT' instead
    // of 'urgent' (or "Side Effect" instead of "Side Effects") would
    // pollute aggregations, misalign pill-UI selection, and split
    // Top Category counts. Helper lives in data/triage-lib.js so
    // it's testable in Node and shared with the eval harness.
    parsed = normalizeTriageOutput(parsed);
    // Telemetry envelope from the proxy. Prefer server-measured latency
    // (excludes the user's own network jitter); fall back to wall-clock
    // here when the proxy is older than this client.
    var relai = data._relai || {};
    var clientLatency = Date.now() - triageStarted;
    var telemetry = {
      model: relai.model || 'claude-sonnet-4-6',
      latency_ms: relai.latency_ms != null ? relai.latency_ms : clientLatency,
      cost_usd: relai.cost_usd != null ? relai.cost_usd : null,
      // Use ?? not || here. A real 0 is meaningful (means "no tokens
      // of this kind"), and `0 || null` would collapse it to null,
      // making it impossible to distinguish "cache cold, 0 reads" from
      // "telemetry missing." Aggregations would still be correct, but
      // we'd lose data fidelity in the row itself.
      input_tokens:           relai.usage ? (relai.usage.input_tokens                ?? null) : null,
      output_tokens:          relai.usage ? (relai.usage.output_tokens               ?? null) : null,
      cache_creation_tokens:  relai.usage ? (relai.usage.cache_creation_input_tokens ?? null) : null,
      cache_read_tokens:      relai.usage ? (relai.usage.cache_read_input_tokens     ?? null) : null,
      prompt_version: getPromptVersion(),
      kb_version: getKBVersion(),
      // Capture the AI's self-rated confidence on every triage (not
      // only when it crossed the review threshold). Lets us calibrate
      // the threshold against actual staff overrides later.
      ai_confidence: (parsed.review_request && typeof parsed.review_request.confidence === 'number')
        ? parsed.review_request.confidence
        : null,
    };
    renderResults(parsed);
    // Await the history save (instead of fire-and-forget) so that
    // currentHistoryId is guaranteed set before setLoading(false) lets
    // the user interact again. Two rapid consecutive triages with
    // fire-and-forget saves can resolve out-of-order, leaving
    // currentHistoryId pointing at the older triage — meaning every
    // subsequent Save Categories / Save Timeframe / Submit & Learn
    // would patch the wrong row. The added wait is ~100-200ms (a DB
    // insert), imperceptible after the ~8s the AI just took. The
    // saveReviewRequest follow-up stays fire-and-forget — it doesn't
    // update any global state.
    var newId = await saveHistoryRecord(parsed, msg, telemetry);
    currentHistoryId = newId;
    if (newId && parsed.review_request && parsed.review_request.question) {
      // Awaited — earlier this was fire-and-forget, which meant if
      // the network blipped or the call errored, the AI's flagged
      // review request was silently lost. The triage row would
      // exist but no review_request linked to it; staff would never
      // see the AI's flagged uncertainty in the Pending Review Items
      // queue, the answer would never feed back into the KB via
      // promoteReviewToKB, and the active learning loop would fail
      // to close on that case. The triage row is the patient-facing
      // outcome (already saved); the review is the learning signal.
      // Both need to land for the loop to work — so both are awaited.
      await saveReviewRequest(parsed.review_request, msg, parsed.draft_response, newId);
    }
  }catch(err){
    var msg = err.message||'Unknown error';
    var isJson = msg.includes('JSON') || msg.includes('Unexpected token') || msg.includes('SyntaxError');
    var isEmpty = msg.includes('Empty response');
    var isTimeout = msg.includes('timeout') || msg.includes('network') || msg.toLowerCase().includes('fetch');
    var title, detail, suggestion;
    if(isJson || isEmpty){
      title = 'Response could not be parsed';
      detail = 'The AI returned a response but it was incomplete or in an unexpected format. This usually happens when the knowledge base is very large and the response gets cut off.';
      suggestion = 'Try again -- if it keeps failing, go to the Knowledge Base and check for any very long entries that could be trimmed.';
    } else if(isTimeout){
      title = 'Connection issue';
      detail = 'The request could not reach the server, or took too long to respond.';
      suggestion = 'Check your internet connection and try again.';
    } else {
      title = 'Triage could not complete';
      detail = msg;
      suggestion = 'Try submitting again. If the error persists, the message may contain content the AI cannot process -- try simplifying or rephrasing it.';
    }
    document.getElementById('results').innerHTML =
      '<div style="background:var(--amber-l);border:1.5px solid var(--amber-m);border-radius:12px;padding:20px 22px;">'+
        '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--amber);margin-bottom:8px;">&#9888; '+esc(title)+'</div>'+
        '<div style="font-size:var(--fs-base);color:var(--gray-800);line-height:1.7;margin-bottom:10px;">'+esc(detail)+'</div>'+
        '<div style="font-size:var(--fs-sm);color:var(--gray-600);line-height:1.6;padding:10px 14px;background:rgba(255,255,255,.6);border-radius:8px;">'+
          '<strong>What to do:</strong> '+esc(suggestion)+
        '</div>'+
      '</div>';
  }finally{setLoading(false);}
}




function buildTimeframeSelect(urgency){
  var mapped=urgency==='urgent'?'urgent':urgency==='same-day'?'same-day':'routine';
  return '<select class="editable-select '+mapped+'" id="timeframeSelect" style="width:auto;max-width:160px;" onchange="onTimeframeChange(this)">'+
    TIMEFRAMES.map(function(o){return '<option value="'+o.v+'"'+(o.v===mapped?' selected':'')+'>'+o.l+'</option>';}).join('')+
  '</select>';
}

function onTimeframeChange(sel){
  var v=sel.value;
  sel.className='editable-select '+(v==='urgent'?'urgent':v==='routine'?'routine':'same-day');
}

async function saveTimeframe(){
  var sel=document.getElementById('timeframeSelect'),btn=document.getElementById('timeframeSaveBtn');
  if(!sel||!btn) return;
  if(!currentHistoryId){ showToast('Run a triage first','warn'); return; }
  btn.disabled=true; btn.style.opacity='0.6';
  try{
    await api('/history','POST',{action:'update_urgency',id:currentHistoryId,urgency_override:sel.value});
    showToast('Timeframe saved');
    btn.style.background='var(--green)'; btn.style.opacity='1';
    setTimeout(function(){btn.style.background='var(--green)';btn.disabled=false;},1500);
  }catch(e){
    showToast('Error saving timeframe','error');
    btn.disabled=false; btn.style.opacity='1';
  }
}



// CORRECTION
//
// Submission flow:
//   1. Compute edit_distance between AI draft and what staff actually sent.
//   2. Collect staff UI selections (categories, timeframe) as STRUCTURED
//      metadata — never inline them into the response text. This was the
//      root cause of an early bug where Haiku read appended metadata as
//      "the nurse edited the response" and confabulated learning notes
//      that weren't true.
//   3. If edit_distance === 0 (staff sent the AI draft verbatim), skip
//      the Haiku analyze call entirely. The signal is "AI nailed it";
//      we write a deterministic note and save the metadata. No reason to
//      pay for an analysis that has no diff to summarize, and asking
//      Haiku to find changes that don't exist invites confabulation.
//   4. If edit_distance > 0, send Haiku the draft, the actual response,
//      AND the metadata as a clearly separated block — with system-prompt
//      instructions that the metadata is UI selections, not edits.
async function submitCorrection(){
  var actual=document.getElementById('correctionInput').value.trim();
  if(!actual){alert('Please paste the response you actually sent.');return;}
  var btn=document.getElementById('correctionSubmitBtn');
  var status=document.getElementById('correctionStatus');
  btn.disabled=true;btn.querySelector('span').textContent='Analyzing...';
  status.textContent='';status.className='learn-status';
  try{
    var aiDraft=document.getElementById('aiDraftText')?document.getElementById('aiDraftText').innerText:'';
    var editDist = levenshteinDistance(aiDraft||'', actual||'');

    // Final state of the staff's UI selections. Note: these are the
    // *current* values, not a diff against what the AI originally
    // proposed — we don't retain the AI's first-pass classification
    // through this function, so Haiku sees the final selection only.
    // Staff-vs-AI category disagreement is captured separately by
    // saveCategoryTags / urgency_override on the row itself.
    var catVals = [].map.call(
      document.querySelectorAll('.cat-pill.sel-clin'),
      function(p){return p.getAttribute('data-val');}
    );
    var tfEl = document.getElementById('timeframeSelect');
    var timeframe = tfEl ? tfEl.value : null;

    var note;
    if(editDist === 0){
      // Verbatim send — the AI got it right. Build the note locally
      // instead of paying Haiku to invent a diff that doesn't exist.
      note = 'Staff sent the AI draft as-is — no edits.';
      var metaSummary = [];
      if(catVals.length) metaSummary.push('final category selection: ' + catVals.join(', '));
      else                metaSummary.push('no clinical category selected');
      if(timeframe)       metaSummary.push('timeframe: ' + timeframe);
      if(metaSummary.length) note += ' (' + metaSummary.join('; ') + ')';
    } else {
      // Real diff — ask Haiku to summarize. Metadata goes in a clearly
      // labeled block that the system prompt explicitly tells Haiku
      // not to treat as response edits.
      var systemPrompt =
        'Compare an AI draft response with what the staff member actually sent. ' +
        'Output 2-3 sentences: what genuinely changed in the response text, what it reveals about the AI gap, one concrete improvement suggestion. ' +
        'Plain text only. ' +
        'IMPORTANT: the "Staff metadata" block (when present) describes UI selections — categories and timeframe the staff chose in the interface. Those are NOT changes to the response text. Never describe metadata fields as additions/edits to the response. ' +
        'If the only differences from the draft are whitespace or punctuation, say so plainly rather than inventing meaning.';
      var userMessage = 'AI draft:\n' + aiDraft + '\n\nStaff sent:\n' + actual;
      var metaLines = [];
      if(catVals.length) metaLines.push('- Final clinical categories: ' + catVals.join(', '));
      else               metaLines.push('- No clinical category selected (staff may have cleared the AI\'s suggested category)');
      if(timeframe)      metaLines.push('- Final timeframe: ' + timeframe);
      if(metaLines.length){
        userMessage += '\n\nStaff metadata (UI selections, NOT response edits):\n' + metaLines.join('\n');
      }

      // authFetch handles auth + auto-refresh on 401. Before v0.3.12
      // this was a raw fetch with a manual Authorization header,
      // which meant an expired session would silently 401 here, the
      // empty Haiku response would fall through, and the user saw
      // the "(empty learning note from analyzer)" fallback. Same
      // root cause as the older missing-Auth bug surfaced by user
      // testing in v0.3.8's first patch.
      var analyzeRes = await authFetch('/.netlify/functions/kb/analyze', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'claude-haiku-4-5', max_tokens:200,
          system: systemPrompt,
          messages:[{role:'user', content: userMessage}]
        })
      });
      var analyzeData=await analyzeRes.json();
      note = (analyzeData.content||[]).map(function(b){return b.text||'';}).join('').trim();
      // If the analyzer genuinely returned nothing useful (rare —
      // Haiku is reliable) AND the response had no error, fall
      // through to a clear placeholder. If analyzeData carried an
      // error, surface it instead of pretending the analyzer was
      // just being terse.
      if (!note) {
        if (analyzeData && analyzeData.error) {
          note = 'Analyzer error: ' + (typeof analyzeData.error === 'string' ? analyzeData.error : JSON.stringify(analyzeData.error)).slice(0, 200);
        } else {
          note = '(empty learning note from analyzer)';
        }
      }
    }

    var duration = triageStartTime ? Math.round((Date.now()-triageStartTime)/1000) : null;
    if(currentHistoryId) await api('/history','POST',{
      action:'save_actual',
      id:currentHistoryId,
      actual_response:actual,
      correction_note:note,
      session_duration_seconds:duration,
      edit_distance:editDist
    });
    status.textContent = note ? ('OK Saved. Learning note: "'+note.substring(0,90)+(note.length>90?'...':'')+'"') : 'OK Response saved.';
    status.className='learn-status success';
    document.getElementById('correctionInput').value='';
  }catch(e){
    console.error('submitCorrection:', e.message);
    status.textContent='Error: '+e.message;
    status.className='learn-status error';
  }
  finally{ btn.disabled=false; btn.querySelector('span').textContent='Submit & Learn'; }
}

// RENDER
// Severity badge reads exclusively from clinical_routing_level -- set by AI using KB rules
// No hardcoded category lists or fallback inference. Single source of truth.
function buildSeverityBadge(routingLevel){
  var level = (routingLevel||'none').toLowerCase();
  var map = {
    'severe': {cls:'sev-severe', label:'Side Effect: Severe'},
    'moderate': {cls:'sev-medium', label:'Side Effect: Moderate'},
    'mild': {cls:'sev-low', label:'Side Effect: Mild'}
  };
  var sev = map[level];
  if(!sev) return '';
  return '<div class="severity-badge '+sev.cls+'"><div class="sev-dot"></div>'+sev.label+'</div>';
}

function renderResults(d){
  var html='';
  var draftText=(d.draft_response||'').trim();
  var draftIsEmpty=!draftText;
  var severityBadge=buildSeverityBadge(d.clinical_routing_level);
  var aiClinCat=(d.clinical_category||'').trim();
  var aiNonClin=(d.non_clinical_items&&d.non_clinical_items.length)?d.non_clinical_items.join(', '):'';
  var _in=d.internal_note||'';
  var routedTo=d.routed_to||'Support Team';
  var hasNonClin=!!(d.non_clinical_flag&&d.non_clinical_items&&d.non_clinical_items.length);
  // Use the shared taskShape/priorityTier helpers so the rendered
  // task type label matches what loadHistory's queue table and
  // priorityTier classifier produce. Earlier inline logic treated
  // "General Inquiry" as real clinical content (because the only
  // exclusion was the dead "General/multiple" value), which made
  // 100%-non-clinical messages render as "Dual Task" — the same
  // bug class flagged in user testing.
  var shape = taskShape(d);          // 'single' | 'dual'
  var tier  = priorityTier(d);       // 'severe-se' | 'moderate-se' | 'mild-se' | 'clinical' | 'non-clinical'
  var taskType =
    shape === 'dual'         ? 'Dual Task'    :
    tier  === 'non-clinical' ? 'Non-Clinical' :
                                'Clinical';
  // Show the severity badge only when the tier is a real side
  // effect (one of the three -se tiers). Earlier this used a
  // local `hasSideEffect && isClinical` check; `isClinical` was
  // removed in v0.3.6 when the inline logic was replaced with
  // priorityTier/taskShape, but a reference to it lingered later
  // in the function — surfaced as "isClinical is not defined" at
  // runtime. Deriving from tier here keeps the badge condition in
  // lockstep with the tier label shown in the queue.
  var isRealSE = tier === 'severe-se' || tier === 'moderate-se' || tier === 'mild-se';

  // Build pills. CLINICAL_CATS / NON_CLINICAL_CATS are both derived
  // from RELAI_DEFAULTS.categories at module load — see top of file.
  var clinPills=CLINICAL_CATS.map(function(c){
    var sel=c===aiClinCat;
    return '<button class="cat-pill'+(sel?' sel-clin':'')+'" data-val="'+esc(c)+'" data-type="clin">'+esc(c)+'</button>';
  }).join(' ');
  var ncPills=NON_CLINICAL_CATS.map(function(c){
    var sel=aiNonClin.includes(c);
    return '<button class="cat-pill'+(sel?' sel-nc':'')+'" data-val="'+esc(c)+'" data-type="nc">'+esc(c)+'</button>';
  }).join(' ');

  // ── Two side-by-side top cards ────────────────────────────────────────────
  html+=
    '<div style="display:grid;grid-template-columns:minmax(200px,240px) 1fr;gap:12px;align-items:start;">'+

      // LEFT — Status + timeframe editable
      '<div class="out-card">'+
        '<div class="oc-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:0;">'+

          // Task type only — no category (categories handled on right card)
          '<div style="padding-bottom:12px;">'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-500);font-weight:600;">Task type: <span style="color:var(--gray-800);font-weight:700;">'+taskType+'</span></div>'+
          '</div>'+

          // Severity badge — shown only for the three -se tiers
          // so the badge stays in sync with the queue's tier label.
          (isRealSE?
            '<div style="padding:10px 0;border-top:1px solid var(--gray-100);">'+
              severityBadge+
            '</div>'
          :'')+

          // Timeframe — with divider, dropdown + green checkmark button
          '<div style="padding-top:12px;border-top:1px solid var(--gray-100);">'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-500);font-weight:600;margin-bottom:6px;">Response Timeframe</div>'+
            '<div style="display:flex;align-items:center;gap:6px;">'+
              buildTimeframeSelect(d.urgency)+
              '<button id="timeframeSaveBtn" onclick="saveTimeframe()" title="Save timeframe" style="flex-shrink:0;width:30px;height:30px;border-radius:7px;border:none;background:var(--green);color:white;cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .2s;">&#10003;</button>'+
            '</div>'+
          '</div>'+

        '</div>'+
      '</div>'+

      // RIGHT — Category correction pills
      '<div class="out-card">'+
        '<div class="oc-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;">'+
          '<div>'+
            '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-600);margin-bottom:7px;">Clinical Category</div>'+
            '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+clinPills+'</div>'+
          '</div>'+
          (hasNonClin?
            '<div style="padding-top:10px;border-top:1px solid var(--gray-100);">'+
              '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-600);margin-bottom:7px;">Non-Clinical Category</div>'+
              '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+ncPills+'</div>'+
            '</div>'
          :'')+
          '<div style="padding-top:10px;border-top:1px solid var(--gray-100);display:flex;justify-content:flex-end;">'+
            '<button class="cat-save-btn" id="catSaveBtn" onclick="saveCategoryTags()">Save</button>'+
          '</div>'+
        '</div>'+
      '</div>'+

    '</div>';

  // ── Routing card — no "clinical first" notice, just the task ─────────────
  if(hasNonClin){
    html+=
      '<div class="out-card" style="border-color:var(--amber-m);">'+
        '<div class="oc-header">'+
          '<span class="oc-label" style="color:var(--amber);">&#128203; Route to Support Team</span>'+
          '<span style="font-size:var(--fs-sm);font-weight:700;color:var(--gray-800);">'+esc(routedTo)+'</span>'+
        '</div>'+
        '<div class="oc-body">'+
          (_in?
            '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-700);margin-bottom:5px;">Internal Note &mdash; share with the support team</div>'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-600);line-height:1.5;margin-bottom:8px;">Copy &rarr; share via your usual internal handoff (thread comment, internal email, ticket) &rarr; assign to <strong>'+esc(routedTo)+'</strong>. You stay responsible for the patient reply.</div>'+
            '<div style="background:var(--amber-l);border:1.5px solid var(--amber-m);border-radius:8px;padding:13px 16px;font-size:var(--fs-base);color:var(--gray-800);line-height:1.75;position:relative;">'+
              esc(_in)+
              '<button class="copy-inline-btn" data-copy-target="internal" style="position:absolute;top:8px;right:8px;background:var(--white);border:1.5px solid var(--amber-m);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;color:var(--amber);font-weight:600;">Copy</button>'+
            '</div>'
          :
            '<div style="font-size:var(--fs-sm);color:var(--gray-600);">No internal note generated. Run triage again if unexpected.</div>'
          )+
        '</div>'+
      '</div>';
  }

  // ── Generated Response ────────────────────────────────────────────────────
  html+=
    '<div class="out-card" style="border-color:'+(draftIsEmpty?'var(--red-m)':'var(--teal-m)')+'">'+
      '<div class="oc-header">'+
        '<span class="oc-label" style="color:'+(draftIsEmpty?'var(--red)':'var(--teal)')+'">'+
          (draftIsEmpty?'&#9888; Response Not Generated':'Generated Response for Patient')+
        '</span>'+
      '</div>'+
      '<div class="oc-body">'+
        (draftIsEmpty?
          '<div style="background:var(--red-l);border:1.5px solid var(--red-m);border-radius:8px;padding:14px 16px;font-size:var(--fs-sm);color:var(--red);line-height:1.7;"><strong>The AI did not generate a response.</strong> Click <strong>Run Triage again</strong>.</div>'
        :
          '<div style="position:relative;margin-bottom:20px;">'+
            '<div class="response-text" id="aiDraftText">'+esc(draftText).split('\n').join('<br>')+'</div>'+
            '<button class="copy-inline-btn" data-copy-target="draft" style="position:absolute;top:8px;right:8px;background:var(--white);border:1.5px solid var(--gray-200);border-radius:6px;padding:4px 9px;cursor:pointer;font-size:12px;color:var(--gray-500);">Copy</button>'+
          '</div>'
        )+
        '<div style="height:1px;background:var(--gray-200);margin:20px 0 12px;"></div><div class="feedback-row"><button class="vote-btn up" id="upvoteBtn">&#128077; Good response</button><button class="vote-btn down" id="downvoteBtn">&#128078; Needs work</button></div>'+
        '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gray-100);">'+
          '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-600);margin-bottom:6px;">What was sent to the patient</div>'+
          '<p style="font-size:var(--fs-sm);color:var(--gray-700);margin-bottom:8px;line-height:1.5;">Paste your actual response if you changed the draft. The AI learns by comparing what you sent to what it generated.</p>'+
          '<textarea id="correctionInput" style="min-height:90px;font-size:var(--fs-sm);" placeholder="Paste the message you sent to the patient..."></textarea>'+
          '<div class="correction-submit-row" style="margin-top:8px;">'+
            '<button class="correction-submit-btn" id="correctionSubmitBtn" onclick="submitCorrection()"><span>Submit &amp; Learn</span><div class="spinner" id="correctionSpinner"></div></button>'+
            '<div class="learn-status" id="correctionStatus"></div>'+
          '</div>'+
        '</div>'+
      '</div>'+
    '</div>';

  var el=document.getElementById('results');
  el.innerHTML=html;

  el.querySelectorAll('.copy-inline-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      var target=btn.getAttribute('data-copy-target');
      var text=target==='internal'?_in:draftText;
      if(!text)return;
      navigator.clipboard.writeText(text).then(function(){
        var orig=btn.textContent;btn.textContent='Copied!';btn.style.color='var(--green)';
        setTimeout(function(){btn.textContent=orig;btn.style.color='';},2000);
      });
    });
  });

  var upBtn=document.getElementById('upvoteBtn');
  var dnBtn=document.getElementById('downvoteBtn');
  if(upBtn) upBtn.addEventListener('click',function(){ castVote('up',upBtn); });
  if(dnBtn) dnBtn.addEventListener('click',function(){ castVote('down',dnBtn); });

  el.querySelectorAll('.cat-pill').forEach(function(pill){
    pill.addEventListener('click',function(){
      var type=pill.getAttribute('data-type');
      if(type==='clin') pill.classList.toggle('sel-clin');
      else pill.classList.toggle('sel-nc');
    });
  });
}


var correctionsLoaded = false;

function toggleCorrectionsPanel(){
  var panel=document.getElementById('corrections-panel');
  var btn=document.getElementById('loadCorrectionsBtn');
  var wasOpen=panel.classList.contains('show');
  panel.classList.toggle('show');
  var nowOpen=!wasOpen;
  btn.textContent=nowOpen?'^ Hide':'v Load';
  if(nowOpen&&!correctionsLoaded)loadCorrections();
}

async function loadCorrections(){
  correctionsLoaded=true;
  var list=document.getElementById('corrections-list');
  list.innerHTML='<div class="empty-state">Loading corrections...</div>';
  try{
    var rows=await api('/history');
    var withCorr=Array.isArray(rows)?rows.filter(function(r){return r.actual_response_sent||r.correction_note;}):[];
    if(!withCorr.length){list.innerHTML='<div class="empty-state">No corrections saved yet.</div>';return;}
    list.innerHTML='';
    withCorr.forEach(function(r){
      var date=new Date(r.created_at).toLocaleDateString();

      // Build card with DOM so delete button closure works cleanly
      var card=document.createElement('div');
      card.style.cssText='border:1.5px solid var(--gray-200);border-radius:10px;margin-bottom:12px;overflow:hidden;';

      // Header row
      var hdr=document.createElement('div');
      hdr.style.cssText='padding:9px 13px;background:var(--gray-50);border-bottom:1px solid var(--gray-200);display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var meta=document.createElement('div');
      meta.style.cssText='display:flex;align-items:center;gap:10px;flex:1;min-width:0;';

      var nameSpan=document.createElement('span');
      nameSpan.style.cssText='font-size:var(--fs-xs);font-weight:600;color:var(--gray-700);';
      nameSpan.textContent=r.nurse_name+' · '+date;

      var catSpan=document.createElement('span');
      catSpan.style.cssText='font-size:var(--fs-xs);color:var(--gray-500);';
      catSpan.textContent=formatCategoryDisplay(r);

      meta.appendChild(nameSpan);
      meta.appendChild(catSpan);

      var delBtn=document.createElement('button');
      delBtn.textContent='Delete';
      delBtn.style.cssText='padding:3px 10px;font-size:11px;font-weight:600;border:1.5px solid var(--red-m);border-radius:6px;background:var(--white);color:var(--red);cursor:pointer;flex-shrink:0;font-family:var(--sans);';
      delBtn.addEventListener('click',function(){deleteCorrection(r.id,card,delBtn);});

      hdr.appendChild(meta);
      hdr.appendChild(delBtn);
      card.appendChild(hdr);

      // Body — side-by-side drafts
      var body=document.createElement('div');
      body.style.cssText='padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:12px;';

      var draftDiv=document.createElement('div');
      var draftLabel=document.createElement('div');
      draftLabel.style.cssText='font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);margin-bottom:6px;';
      draftLabel.textContent='AI Draft';
      var draftText=document.createElement('div');
      draftText.style.cssText='font-size:var(--fs-xs);color:var(--gray-600);line-height:1.6;white-space:pre-wrap;';
      var dr=r.draft_response||'';
      draftText.textContent=dr.length>280?dr.substring(0,280)+'...':dr;
      draftDiv.appendChild(draftLabel);
      draftDiv.appendChild(draftText);

      var sentDiv=document.createElement('div');
      var sentLabel=document.createElement('div');
      sentLabel.style.cssText='font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--teal);margin-bottom:6px;';
      sentLabel.textContent='Actually Sent';
      var sentText=document.createElement('div');
      sentText.style.cssText='font-size:var(--fs-xs);color:var(--gray-700);line-height:1.6;white-space:pre-wrap;';
      var sr=r.actual_response_sent||'';
      sentText.textContent=sr.length>280?sr.substring(0,280)+'...':sr;
      sentDiv.appendChild(sentLabel);
      sentDiv.appendChild(sentText);

      body.appendChild(draftDiv);
      body.appendChild(sentDiv);
      card.appendChild(body);

      // Learning note if present
      if(r.correction_note){
        var noteRow=document.createElement('div');
        noteRow.style.cssText='padding:8px 14px 12px;border-top:1px solid var(--gray-100);';
        var noteLabel=document.createElement('div');
        noteLabel.style.cssText='font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orange);margin-bottom:4px;';
        noteLabel.textContent='Learning note';
        var noteText=document.createElement('div');
        noteText.style.cssText='font-size:var(--fs-xs);color:var(--gray-700);line-height:1.6;';
        noteText.textContent=r.correction_note;
        noteRow.appendChild(noteLabel);
        noteRow.appendChild(noteText);
        card.appendChild(noteRow);
      }

      list.appendChild(card);
    });
  }catch(e){
    console.error('loadCorrections:', e.message);
    list.innerHTML='<div class="empty-state" style="color:var(--red);">Error: '+esc(e.message)+'</div>';
  }
}

async function deleteCorrection(id,cardEl,btn){
  if(!confirm('Delete this correction? This removes the learned note and cannot be undone.'))return;
  btn.textContent='Deleting...';
  btn.disabled=true;
  try{
    await api('/history','POST',{action:'delete_correction',id:id});
    cardEl.style.opacity='0';
    cardEl.style.transition='opacity .3s';
    setTimeout(function(){
      if(cardEl.parentNode)cardEl.parentNode.removeChild(cardEl);
      var list=document.getElementById('corrections-list');
      if(list&&!list.querySelector('div[style*="border"]')){
        list.innerHTML='<div class="empty-state">No corrections saved yet.</div>';
      }
    },300);
    showToast('Correction deleted');
  }catch(e){
    btn.textContent='Delete';
    btn.disabled=false;
    showToast('Error deleting correction');
  }
}

async function saveCategoryTags(){
  var btn=document.getElementById('catSaveBtn');
  if(!btn) return;
  if(!currentHistoryId){ showToast('Run a triage first','warn'); return; }
  btn.textContent='Saving...'; btn.disabled=true;
  try{
    // Collect clinical + non-clinical separately. Persist them in
    // their proper columns: clinical_category (text) and
    // non_clinical_items (jsonb array). Earlier code joined both
    // into one concatenated string and stuffed it into
    // clinical_category, which corrupted aggregations like
    // "Top Category" and made history rows hard to filter.
    var clinVals=[],ncVals=[];
    document.querySelectorAll('.cat-pill.sel-clin').forEach(function(p){clinVals.push(p.getAttribute('data-val'));});
    document.querySelectorAll('.cat-pill.sel-nc').forEach(function(p){ncVals.push(p.getAttribute('data-val'));});
    var tfSel=document.getElementById('timeframeSelect');
    var saves=[api('/history','POST',{
      action:'update_category',
      id:currentHistoryId,
      category: clinVals.join(', '),                                           // clinical_category
      non_clinical_items: ncVals,                                              // jsonb array
      non_clinical_flag: ncVals.length > 0
    })];
    if(tfSel) saves.push(api('/history','POST',{action:'update_urgency',id:currentHistoryId,urgency_override:tfSel.value}));
    await Promise.all(saves);
    btn.textContent='Saved ✓'; btn.className='cat-save-btn saved';
    showToast('Categories saved');
    setTimeout(function(){btn.textContent='Save';btn.className='cat-save-btn';btn.disabled=false;},2000);
  }catch(e){
    console.error('saveCategoryTags:', e.message);
    showToast('Error saving categories','error');
    btn.textContent='Save'; btn.disabled=false;
  }
}


async function castVote(type, btn){
  if(!currentHistoryId){ showToast('Run a triage first','warn'); return; }
  if(btn.classList.contains('active')) return;
  try{
    await api('/history','POST',{action: type==='up'?'upvote':'downvote', id:currentHistoryId, reason: type==='up'?'Good response':'Needs improvement'});
    var up=document.getElementById('upvoteBtn'), dn=document.getElementById('downvoteBtn');
    if(up) up.classList.remove('active');
    if(dn) dn.classList.remove('active');
    btn.classList.add('active');
    showToast(type==='up'?'Positive feedback saved':'Flagged for review');
  } catch(e){
    console.error('castVote:', e.message);
    showToast('Error saving feedback');
  }
}

// Compact plain-text preview of a patient_message for the history
// table's Message column and the delete-confirm dialog. Collapses
// whitespace (including the patient's newlines) to single spaces so
// the preview reads as one line, then truncates to `max` chars with
// an ellipsis. Returns plain text — caller is responsible for
// HTML-escaping when rendering to the DOM. The dialog uses it raw.
function previewPatientMessage(text, max){
  if(!text) return '';
  max = max || 80;
  var clean = String(text).replace(/\s+/g, ' ').trim();
  if(clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';   // …
}

// Build the inner HTML for an expanded history-row detail panel.
// Click on a row inserts a sibling <tr> containing this. Shows only
// the fields that actually have data, so non-clinical rows don't
// show empty follow-up sections, etc. All fields are esc()'d
// because patient_message and draft_response are user/AI content
// and may contain HTML-like characters.
function buildHistoryDetailHtml(r){
  if(!r) return '<div class="history-detail-block">No detail available.</div>';
  var parts = [];
  // Always show patient_message — it's why the row exists.
  parts.push(
    '<div class="history-detail-block">'+
      '<div class="history-detail-label">Patient Message</div>'+
      '<div class="history-detail-text">'+esc(r.patient_message || '(empty)')+'</div>'+
    '</div>'
  );
  if(r.draft_response){
    parts.push(
      '<div class="history-detail-block">'+
        '<div class="history-detail-label">AI Draft Response</div>'+
        '<div class="history-detail-text">'+esc(r.draft_response)+'</div>'+
      '</div>'
    );
  }
  // Show actual_response_sent only if it actually differs from the
  // AI draft. Same text as the draft means the staff member sent it
  // verbatim — showing it again is just noise.
  if(r.actual_response_sent && r.actual_response_sent !== r.draft_response){
    parts.push(
      '<div class="history-detail-block">'+
        '<div class="history-detail-label">Sent to Patient</div>'+
        '<div class="history-detail-text">'+esc(r.actual_response_sent)+'</div>'+
      '</div>'
    );
  }
  if(r.internal_note){
    parts.push(
      '<div class="history-detail-block">'+
        '<div class="history-detail-label">Internal Note (Support Handoff)</div>'+
        '<div class="history-detail-text">'+esc(r.internal_note)+'</div>'+
      '</div>'
    );
  }
  if(Array.isArray(r.follow_up_questions) && r.follow_up_questions.length){
    parts.push(
      '<div class="history-detail-block">'+
        '<div class="history-detail-label">Follow-up Questions</div>'+
        '<ul class="history-detail-list">'+
          r.follow_up_questions.map(function(q){
            return '<li>'+esc(q)+'</li>';
          }).join('')+
        '</ul>'+
      '</div>'
    );
  }
  if(r.correction_note){
    parts.push(
      '<div class="history-detail-block">'+
        '<div class="history-detail-label">Correction Note</div>'+
        '<div class="history-detail-text">'+esc(r.correction_note)+'</div>'+
      '</div>'
    );
  }
  return parts.join('');
}

// Toggle the expanded detail panel below a history row. Looked up
// via data-history-row attribute on the row. If a detail row
// already sits below this one, remove it (collapse); otherwise
// build one and insert it. We don't re-fetch the row data — it's
// cached in historyRowsById from the most recent loadHistory.
function toggleHistoryRowDetail(id){
  if(!id) return;
  var row = document.querySelector('tr[data-history-row="'+id+'"]');
  if(!row) return;
  var next = row.nextElementSibling;
  if(next && next.classList.contains('history-detail-row')){
    next.parentNode.removeChild(next);
    row.classList.remove('expanded');
    return;
  }
  var data = historyRowsById[id];
  if(!data) return;
  var detail = document.createElement('tr');
  detail.className = 'history-detail-row';
  // The history table currently has 11 columns (Score, Priority,
  // Type, Date, Staff, Message, Category, Urgency, Corrected,
  // Time, ×). colspan must match or the detail row won't span the
  // full width.
  detail.innerHTML = '<td colspan="11">'+buildHistoryDetailHtml(data)+'</td>';
  row.parentNode.insertBefore(detail, row.nextSibling);
  row.classList.add('expanded');
}

// Sync top + bottom page-size selectors and re-render the table.
// Both selects fire this handler with `this` set to the one the
// user changed. We mirror the new value onto the other select
// (without firing its onchange — assignment to .value doesn't
// trigger change events) then call loadHistory to re-read the
// value and re-render. loadHistory re-fetches /history/all,
// which is fine: the call is cheap (~200 rows, indexed query,
// no AI cost) and re-fetching keeps the displayed window in
// sync with whatever's actually in the DB. If the cost ever
// matters we can swap to a pure client-side re-render of the
// already-cached historyRowsById, but at current scale this is
// the simplest correct thing.
//
// Page size changes reset to page 1 via loadHistory's default
// resetPage=true. Otherwise the user might be on page 12 of
// "Show 10" and switch to "Show 100" — page 12 doesn't exist
// in the larger window and they'd see the clamp result, which
// is jarring. Start at top after any size change.
function onHistoryPageSizeChange(srcSelect){
  var newVal = srcSelect ? srcSelect.value : '25';
  var topSel = document.getElementById('historyPageSize');
  var botSel = document.getElementById('historyPageSizeBottom');
  if (topSel && topSel !== srcSelect) topSel.value = newVal;
  if (botSel && botSel !== srcSelect) botSel.value = newVal;
  loadHistory();
}

// Pagination: move forward or back by `delta` (typically +1 or -1).
// Calls loadHistory({resetPage:false}) so the page change persists
// instead of being immediately snapped back to 1.
// loadHistory still clamps to [1, totalPages] at render time, so
// passing a delta that would overshoot just lands on the boundary.
function changeHistoryPage(delta){
  historyCurrentPage = historyCurrentPage + delta;
  loadHistory({ resetPage: false });
}

// Build one pagination bar (top OR bottom) with prev/next buttons,
// a "Page X of Y" indicator, and an "Showing M–N of Z" range label.
// The bottom bar additionally renders the page-size selector — top
// doesn't, because the same control already lives in the header
// .history-controls block, and duplicating it three times feels
// noisy.
function buildHistoryPageBar(opts){
  var page = opts.page;
  var totalPages = opts.totalPages;
  var startIdx = opts.startIdx;
  var endIdx = opts.endIdx;
  var totalRows = opts.totalRows;
  var isBottom = !!opts.isBottom;
  var pageSizeRaw = opts.pageSizeRaw;
  var prevDisabled = page <= 1;
  var nextDisabled = page >= totalPages;
  var rangeLabel = totalRows === 0
    ? 'No records'
    : 'Showing ' + (startIdx + 1) + '–' + endIdx + ' of ' + totalRows;
  // Only render the page-size select on the bottom bar.
  var sizeSelectHtml = '';
  if (isBottom) {
    sizeSelectHtml =
      '<select id="historyPageSizeBottom" class="history-filter" onchange="onHistoryPageSizeChange(this)" title="How many rows to show at once">'+
        '<option value="10"' +(pageSizeRaw==='10' ?' selected':'')+'>Show 10</option>'+
        '<option value="25" '+(pageSizeRaw==='25' ?' selected':'')+'>Show 25</option>'+
        '<option value="50" '+(pageSizeRaw==='50' ?' selected':'')+'>Show 50</option>'+
        '<option value="100"'+(pageSizeRaw==='100'?' selected':'')+'>Show 100</option>'+
        '<option value="all"'+(pageSizeRaw==='all'?' selected':'')+'>Show all</option>'+
      '</select>';
  }
  return '<div class="history-page-bar history-page-bar-' + (isBottom ? 'bottom' : 'top') + '">'+
    '<span class="history-page-range">'+esc(rangeLabel)+'</span>'+
    '<div class="history-page-nav">'+
      '<button class="history-page-btn"'+(prevDisabled?' disabled':'')+' onclick="changeHistoryPage(-1)" aria-label="Previous page">&larr; Prev</button>'+
      '<span class="history-page-indicator">Page '+page+' of '+totalPages+'</span>'+
      '<button class="history-page-btn"'+(nextDisabled?' disabled':'')+' onclick="changeHistoryPage(1)" aria-label="Next page">Next &rarr;</button>'+
    '</div>'+
    sizeSelectHtml+
  '</div>';
}

// loadHistory(opts):
//   opts.resetPage (default true) — reset historyCurrentPage to 1
//     before rendering. Plain user-initiated calls (filter/sort/
//     size change, Load button) want this. Internal refreshes
//     after a delete pass resetPage:false so the staff member
//     stays on the page they were working through.
async function loadHistory(opts){
  // Default resetPage to true. Any plain `loadHistory()` call —
  // filter/sort/size change, Load button — wants to land on page
  // 1. Internal callers that should preserve the current page
  // (deleteHistoryEntry after a successful delete, etc.) pass
  // {resetPage: false} explicitly.
  opts = opts || {};
  if (opts.resetPage !== false) {
    historyCurrentPage = 1;
  }
  var filter = document.getElementById('historyFilter');
  var filterVal = filter ? filter.value : 'all';
  var list = document.getElementById('historyList');
  var stats = document.getElementById('historyStats');
  list.innerHTML = '<div class="history-empty">Loading...</div>';
  try{
    var rows = await api('/history/all');
    if(!Array.isArray(rows)||!rows.length){
      stats.innerHTML = '';
      list.innerHTML = '<div class="history-empty">No records yet.</div>';
      return;
    }

    // Tag every row with its priority tier and task shape so filter +
    // display agree.
    rows.forEach(function(r){
      r._tier = priorityTier(r);
      r._shape = taskShape(r);
    });

    // Filter
    var filtered = rows.filter(function(r){
      if(filterVal==='severe-se')   return r._tier==='severe-se';
      if(filterVal==='any-se')      return r._tier==='severe-se' || r._tier==='moderate-se' || r._tier==='mild-se';
      if(filterVal==='clinical')    return r._tier==='clinical';
      if(filterVal==='non-clinical')return r._tier==='non-clinical';
      if(filterVal==='urgent')      return r.urgency_score>=9;
      if(filterVal==='corrected')   return r.actual_response_sent;
      return true;
    });

    // Predicate: was this triage genuinely *edited* by staff?
    // "Edit" means edit_distance > 0 (text actually changed). When
    // edit_distance is null on legacy rows that don't have it
    // populated, fall back to the older heuristic
    // (actual_response_sent != null), which conservatively counts
    // any saved actual-sent as an edit.
    //
    // Why this matters: post-d8b6763 the verbatim-send flow ALSO
    // sets actual_response_sent (so the row carries the confirmed
    // text), with edit_distance = 0. Counting any non-null
    // actual_response_sent as an "edit" therefore conflates
    // verbatim approvals with real edits — the opposite signal.
    function wasEdited(r){
      if (r.edit_distance != null) return r.edit_distance > 0;
      return !!r.actual_response_sent;
    }

    // Aggregate stats
    var total = rows.length;
    var escalated = rows.filter(function(r){return r.clinical_routing_level&&r.clinical_routing_level!=='none';}).length;
    var edited = rows.filter(wasEdited).length;
    var avgScore = rows.reduce(function(a,r){return a+(r.urgency_score||0);},0)/Math.max(total,1);
    var editRate = Math.round((edited/Math.max(total,1))*100);

    var durRows = rows.filter(function(r){return r.session_duration_seconds && r.session_duration_seconds > 0;});
    var avgDur = durRows.length ? durRows.reduce(function(a,r){return a+r.session_duration_seconds;},0)/durRows.length : 0;

    var catCounts = {};
    rows.forEach(function(r){
      var c = r.clinical_category||'Unknown';
      catCounts[c] = (catCounts[c]||0)+1;
    });
    var topCat = Object.keys(catCounts).sort(function(a,b){return catCounts[b]-catCounts[a];})[0] || '—';

    stats.innerHTML = [
      {label:'Total Triages', val:total, color:'var(--blue)'},
      {label:'Avg Priority Score', val:avgScore.toFixed(1)+' / 10', color:'var(--gray-700)'},
      {label:'Escalated', val:escalated, color:'var(--amber)'},
      {label:'Edit Rate', val:editRate+'%', color:editRate>40?'var(--amber)':'var(--green)'},
      {label:'Avg Time / Triage', val:formatDuration(avgDur), color:'var(--gray-700)'},
      {label:'Top Category', val:topCat, color:'var(--gray-700)', wide:true}
    ].map(function(s){
      return '<div class="stat-card'+(s.wide?' stat-card-wide':'')+'">'+
        '<div class="stat-label">'+s.label+'</div>'+
        '<div class="stat-value" style="color:'+s.color+';">'+esc(String(s.val))+'</div>'+
      '</div>';
    }).join('');

    // Per-staff breakdown
    var byStaff = {};
    rows.forEach(function(r){
      var name = r.nurse_name || 'Unknown';
      var s = byStaff[name] || (byStaff[name] = {count:0, scoreSum:0, edited:0, escalated:0, durSum:0, durCount:0});
      s.count++;
      s.scoreSum += r.urgency_score||0;
      if(wasEdited(r)) s.edited++;
      if(r.clinical_routing_level && r.clinical_routing_level !== 'none') s.escalated++;
      if(r.session_duration_seconds && r.session_duration_seconds > 0){
        s.durSum += r.session_duration_seconds;
        s.durCount++;
      }
    });
    var staffRows = Object.keys(byStaff).map(function(name){
      var s = byStaff[name];
      return {
        name: name,
        count: s.count,
        avgScore: (s.scoreSum/s.count).toFixed(1),
        editRate: Math.round((s.edited/s.count)*100),
        escalated: s.escalated,
        avgDur: s.durCount ? formatDuration(s.durSum/s.durCount) : '—'
      };
    }).sort(function(a,b){return b.count-a.count;});

    var staffHtml = '';
    if(staffRows.length){
      staffHtml =
        '<div class="staff-breakdown">'+
          '<div class="staff-breakdown-title">Per-Staff Breakdown</div>'+
          '<table class="data-table">'+
            '<thead><tr>'+
              '<th>Staff</th>'+
              '<th class="num">Triages</th>'+
              '<th class="num">Avg Score</th>'+
              '<th class="num">Edit Rate</th>'+
              '<th class="num">Escalated</th>'+
              '<th class="num">Avg Time</th>'+
            '</tr></thead>'+
            '<tbody>'+
            staffRows.map(function(s){
              return '<tr>'+
                '<td class="staff-name">'+esc(s.name)+'</td>'+
                '<td class="num">'+s.count+'</td>'+
                '<td class="num">'+s.avgScore+'</td>'+
                '<td class="num">'+s.editRate+'%</td>'+
                '<td class="num">'+s.escalated+'</td>'+
                '<td class="num">'+s.avgDur+'</td>'+
              '</tr>';
            }).join('')+
            '</tbody>'+
          '</table>'+
        '</div>';
    }

      // Triage queue table — sorted by priority score so the most pressing
    // tasks land at the top, exactly how the queue should behave when
    // any inbound channel (Bask, email, Healthie, SMS, etc.) starts
    // pushing tasks in automatically.
    var tierLabel = {
      'severe-se':   'Severe SE',
      'moderate-se': 'Moderate SE',
      'mild-se':     'Mild SE',
      'clinical':    'Clinical',
      'non-clinical':'Non-Clinical'
    };
    var tierColor = {
      'severe-se':   'var(--red)',
      'moderate-se': 'var(--amber)',
      'mild-se':     'var(--green)',
      'clinical':    'var(--blue)',
      'non-clinical':'var(--gray-500)'
    };
    // Honor the sort dropdown ("Newest first" by default; "Priority
    // first" reproduces the older queue-style ordering for staff
    // working a live queue who want most-urgent-on-top). Default is
    // newest because the current workflow is "what did I just do",
    // not "what's next in the live queue" — the live-queue surface
    // is Phase 3.
    var sortVal = (document.getElementById('historySort') || {}).value || 'newest';
    var sortedRows;
    if (sortVal === 'priority') {
      sortedRows = filtered.slice().sort(function(a,b){
        var sa = a.urgency_score||0, sb = b.urgency_score||0;
        if(sb !== sa) return sb - sa;                                   // higher score first
        return new Date(b.created_at) - new Date(a.created_at);         // tiebreak newest
      });
    } else {
      // Newest first. Pure created_at sort. The /history/all endpoint
      // already returns up to 200 rows ordered newest-first; we
      // re-sort defensively in case the server changes that, and to
      // be consistent across both sort modes.
      sortedRows = filtered.slice().sort(function(a,b){
        return new Date(b.created_at) - new Date(a.created_at);
      });
    }

    var sortLabel = sortVal === 'priority' ? 'sorted by priority' : 'sorted newest first';
    // Page-size + page-number slice (v0.3.21 + v0.3.24). Staff asked
    // for both a window-size selector (10/25/50/100/all) AND prev/
    // next pagination so they don't have to bump the size to see
    // older rows. Server still caps at 200 rows total; this is
    // purely a client-side display window.
    var pageSizeSel = document.getElementById('historyPageSize');
    var pageSizeRaw = pageSizeSel ? pageSizeSel.value : '25';
    var pageSizeNum = pageSizeRaw === 'all' ? sortedRows.length : parseInt(pageSizeRaw, 10);
    if (!pageSizeNum || pageSizeNum < 1) pageSizeNum = 25;
    // Compute totalPages and clamp historyCurrentPage. If a filter
    // reduces the row count below the current page (e.g., user is
    // on page 5 of "Show 10" with 47 rows = 5 pages, then filters
    // to "urgent only" with 8 rows = 1 page), snap to the last
    // valid page rather than rendering blank.
    var totalPages = sortedRows.length === 0
      ? 1
      : Math.max(1, Math.ceil(sortedRows.length / pageSizeNum));
    if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;
    if (historyCurrentPage < 1) historyCurrentPage = 1;
    var startIdx = (historyCurrentPage - 1) * pageSizeNum;
    var endIdx = Math.min(startIdx + pageSizeNum, sortedRows.length);
    var displayedRows = sortedRows.slice(startIdx, endIdx);
    // Repopulate the row cache so toggleHistoryRowDetail and the
    // delete-confirm dialog have current data. Cleared+rebuilt on
    // every loadHistory so it never drifts. Cache ALL sortedRows
    // (not just the displayed slice) so users can change page-size
    // or page number without losing access to a previously expanded
    // row's data.
    historyRowsById = {};
    sortedRows.forEach(function(r){ historyRowsById[r.id] = r; });
    var countLabel = sortedRows.length === 0
      ? 'No records'
      : (totalPages === 1
          ? sortedRows.length + ' record' + (sortedRows.length === 1 ? '' : 's')
          : 'showing ' + (startIdx + 1) + '–' + endIdx + ' of ' + sortedRows.length);
    var tableHtml =
      '<div class="data-table-wrap">'+
        '<div class="data-table-title">Recent Triages — '+sortLabel+' &middot; '+countLabel+' &middot; click a row to expand</div>'+
        '<table class="data-table data-table-clickable">'+
          '<thead><tr>'+
            '<th class="num">Score</th>'+
            '<th>Priority</th>'+
            '<th>Type</th>'+
            '<th>Date</th>'+
            '<th>Staff</th>'+
            '<th>Message</th>'+
            '<th>Category</th>'+
            '<th>Urgency</th>'+
            '<th class="num">Corrected</th>'+
            '<th class="num">Time</th>'+
            '<th class="num"></th>'+
          '</tr></thead>'+
          '<tbody>'+
          // Iterate displayedRows (page-size-sliced). historyRowsById
          // still indexes ALL sortedRows so changing the page-size
          // dropdown re-renders without a server fetch.
          displayedRows.map(function(r){
            var dt = new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
            var score = r.urgency_score||'-';
            var scoreColor = score>=9?'var(--red)':score>=6?'var(--amber)':score>=3?'var(--blue)':'var(--gray-500)';
            var urg = r.urgency_override||r.urgency_original||'-';
            var corrected = r.actual_response_sent?'<span style="color:var(--green);">&#10003;</span>':'<span style="color:var(--gray-300);">—</span>';
            var dur = formatDuration(r.session_duration_seconds);
            var tier = r._tier || 'clinical';
            // Empty cell for single tasks keeps the queue visually quiet;
            // dual tasks get a small amber pill so staff know there's a
            // routing step in addition to the clinical reply.
            var shapeCell = r._shape === 'dual'
              ? '<span class="task-shape-pill task-shape-dual">Dual</span>'
              : '<span class="task-shape-muted">—</span>';
            // Preview the patient message in the Message column. ~80
            // chars is enough to distinguish "I started 2.5mg of
            // tirzepatide..." from "Hey I had a question about my
            // shipment..." without taking over the row width.
            var msgPreview = previewPatientMessage(r.patient_message, 80);
            var msgCell = msgPreview
              ? esc(msgPreview)
              : '<span style="color:var(--gray-300);">(empty)</span>';
            return '<tr data-history-row="'+r.id+'" onclick="toggleHistoryRowDetail(\''+r.id+'\')">'+
              '<td class="num" style="font-weight:700;color:'+scoreColor+';">'+score+'</td>'+
              '<td style="color:'+tierColor[tier]+';font-weight:600;">'+tierLabel[tier]+'</td>'+
              '<td>'+shapeCell+'</td>'+
              '<td>'+dt+'</td>'+
              '<td class="staff-name">'+esc(r.nurse_name||'')+'</td>'+
              '<td class="message-preview">'+msgCell+'</td>'+
              '<td>'+esc(formatCategoryDisplay(r))+'</td>'+
              '<td>'+esc(urg)+'</td>'+
              '<td class="num">'+corrected+'</td>'+
              '<td class="num">'+dur+'</td>'+
              // stopPropagation on the × so clicking it doesn't also
              // toggle the row's expand state — those are two
              // separate intents and need to stay decoupled.
              '<td class="num"><button class="row-delete" onclick="event.stopPropagation(); deleteHistoryEntry(\''+r.id+'\')" title="Delete this entry permanently">&times;</button></td>'+
            '</tr>';
          }).join('')+
          '</tbody>'+
        '</table>'+
      '</div>';

    // Top + bottom pagination bars. The top bar sits just above the
    // table (after the per-staff breakdown block) so staff working
    // at the top of the list can jump pages without scrolling. The
    // bottom bar adds a page-size selector so staff who scrolled
    // through a long page have controls within reach. Buttons
    // auto-disable when there's no next/prev page; "No records"
    // / "Page 1 of 1" still render so the chrome doesn't pop in
    // and out as filters change row counts.
    var barOpts = {
      page: historyCurrentPage,
      totalPages: totalPages,
      startIdx: startIdx,
      endIdx: endIdx,
      totalRows: sortedRows.length,
      pageSizeRaw: pageSizeRaw
    };
    var topBarHtml = buildHistoryPageBar(Object.assign({}, barOpts, {isBottom: false}));
    var bottomBarHtml = buildHistoryPageBar(Object.assign({}, barOpts, {isBottom: true}));

    list.innerHTML = staffHtml + topBarHtml + tableHtml + bottomBarHtml;
  }catch(e){
    list.innerHTML = '<div style="color:var(--red);padding:20px;">Error: '+esc(e.message)+'</div>';
  }
}



// Delete a single triage entry permanently. Wired to the × button on
// each row of the History table (v0.3.18). Used when staff enter
// wrong content into the triage form — e.g. pasting their own reply
// into the patient-message field. Without a delete option, staff
// would have to leave the app and run DELETE in Supabase manually,
// which was the friction this fixes.
//
// Confirm dialog is intentionally explicit about scope:
//   - The query_history row is hard-deleted (no soft-delete column;
//     the row is gone).
//   - Any UNRESOLVED review_request attached is also deleted
//     server-side (FK cleanup; review_requests.triage_id has no
//     CASCADE).
//   - KB entries already promoted from this triage live in a
//     separate kb_entries row and are NOT touched. The lesson the
//     AI learned survives. Staff manage KB entries from the KB tab.
//
// currentHistoryId guard: if the user just ran a triage on the
// Triage tab and immediately came over here to delete it, the
// Triage tab still holds currentHistoryId pointing at that row.
// Any follow-up actions (save_actual, update_urgency, votes) from
// the Triage tab would then 404. Clearing it here prevents that.
async function deleteHistoryEntry(id){
  if(!id) return;
  // Look up the row in the cached map (populated by loadHistory) so
  // the confirm dialog can quote the patient message back to the
  // user. Third checkpoint against accidental delete: the column
  // preview shows what the row is about, expand-on-click shows
  // full detail, and the dialog repeats the preview at the moment
  // of the destructive action.
  var row = historyRowsById[id];
  var preview = row ? previewPatientMessage(row.patient_message, 120) : '';
  var msg = 'Delete this triage entry permanently?\n\n';
  if(preview){
    msg += '"' + preview + '"\n\n';
  }
  msg += 'This removes the entry and any unresolved review request attached to it. ' +
    'KB entries already promoted from this triage are NOT affected.';
  if(!confirm(msg)) return;
  try{
    await api('/history','POST',{action:'delete_entry', id:id});
    if(currentHistoryId === id) currentHistoryId = null;
    // Preserve current page after delete (v0.3.24). Staff working
    // through page 3 of cleanup don't want to be snapped back to
    // page 1 every time they delete a row. The clamp in
    // loadHistory still moves them back if their current page no
    // longer exists (e.g., last row on the last page just got
    // deleted).
    loadHistory({ resetPage: false });
  }catch(e){
    alert('Could not delete: ' + (e.message || 'unknown error'));
  }
}

function goToClarifications(){
  closeProfile();
  var histBtn = document.getElementById('historyTabBtn');
  if(histBtn) switchTab('history', histBtn);
}

async function saveReviewRequest(reviewRequest, patientMsg, aiDraft, triageId){
  try{
    await api('/reviews','POST',{
      action: 'create',
      triage_id: triageId,
      company_id: getCompanyId(),
      created_by: getUserId(),
      question: reviewRequest.question,
      context: reviewRequest.context || 'general',
      confidence: reviewRequest.confidence || null,
      patient_message: (patientMsg||'').substring(0,500),
      ai_draft: (aiDraft||'').substring(0,500)
    });
    // Refresh badge count
    loadReviews();
  }catch(e){
    console.error('saveReviewRequest:', e.message);
  }
}

async function loadReviews(){
  try{
    var rows = await api('/reviews');
    var pending = Array.isArray(rows) ? rows.filter(function(r){return r.status==='pending';}) : [];
    updateReviewBadge(pending.length);
    window._pendingReviews = pending;
    renderReviews(pending);
  }catch(e){
    console.error('loadReviews:', e.message);
  }
}

function updateReviewBadge(count){
  var badge = document.getElementById('clarificationBadge');
  var profBadge = document.getElementById('profileBadgeCount');
  if(badge){
    badge.style.display = count > 0 ? 'flex' : 'none';
    badge.textContent = count > 9 ? '9+' : String(count);
  }
  if(profBadge) profBadge.textContent = count > 0 ? String(count) : '';
}

function renderReviews(pending){
  var list = document.getElementById('clarificationList');
  var countEl = document.getElementById('clarificationCount');
  if(!list) return;

  if(countEl){
    countEl.textContent = pending.length > 0 ? pending.length + ' pending' : '';
    countEl.style.display = pending.length > 0 ? '' : 'none';
  }

  list.innerHTML = '';

  if(!pending.length){
    list.innerHTML = '<div style="text-align:center;padding:32px 20px;color:var(--gray-400);font-size:var(--fs-sm);">No pending items. The AI is operating with high confidence.</div>';
    return;
  }

  var contextLabels = {routing:'Routing Decision',severity:'Severity Classification',category:'Category Assignment',kb_gap:'Knowledge Gap',protocol:'Protocol Question',general:'General Review'};

  pending.forEach(function(item){
    var conf = item.confidence ? Math.round(item.confidence * 100) + '%' : 'n/a';
    var confColor = item.confidence < 0.5 ? 'var(--red)' : item.confidence < 0.7 ? 'var(--amber)' : 'var(--green)';
    var label = contextLabels[item.context] || item.context || 'Review';
    var excerpt = item.patient_message ? item.patient_message.substring(0,120) + (item.patient_message.length > 120 ? '...' : '') : '';

    // Card
    var card = document.createElement('div');
    card.id = 'review-' + item.id;
    card.style.cssText = 'border:1.5px solid var(--gray-200);border-radius:12px;overflow:hidden;margin-bottom:12px;';

    // Header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'padding:12px 16px;background:var(--gray-50);border-bottom:1px solid var(--gray-100);display:flex;align-items:center;justify-content:space-between;gap:12px;';
    hdr.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">' + esc(label) + '</span>' +
      '<span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:8px;background:var(--gray-100);color:' + confColor + ';">AI confidence: ' + conf + '</span>' +
      '</div>' +
      '<span style="font-size:11px;color:var(--gray-400);">' + new Date(item.created_at).toLocaleDateString() + '</span>';

    // Body
    var body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px;';

    var qDiv = document.createElement('div');
    qDiv.style.cssText = 'font-size:var(--fs-base);font-weight:600;color:var(--gray-800);margin-bottom:8px;line-height:1.5;';
    qDiv.textContent = item.question;
    body.appendChild(qDiv);

    if(excerpt){
      var exDiv = document.createElement('div');
      exDiv.style.cssText = 'font-size:var(--fs-xs);color:var(--gray-500);background:var(--gray-50);border-radius:7px;padding:8px 10px;margin-bottom:12px;line-height:1.5;font-style:italic;';
      exDiv.textContent = 'Patient: "' + excerpt + '"';
      body.appendChild(exDiv);
    }

    var ta = document.createElement('textarea');
    ta.id = 'ans-' + item.id;
    ta.style.cssText = 'width:100%;min-height:80px;padding:10px 12px;border:1.5px solid var(--gray-200);border-radius:8px;font-family:var(--sans);font-size:var(--fs-sm);resize:vertical;outline:none;color:var(--gray-800);';
    ta.placeholder = 'Your answer — be specific. This will be applied to the KB or used to improve routing logic.';
    body.appendChild(ta);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;align-items:center;';

    var submitBtn = document.createElement('button');
    submitBtn.style.cssText = 'padding:8px 18px;background:var(--blue);border:none;border-radius:8px;color:white;font-family:var(--sans);font-size:var(--fs-sm);font-weight:600;cursor:pointer;';
    submitBtn.textContent = 'Submit Answer';
    (function(itemId, itemQ, itemCtx){
      submitBtn.addEventListener('click', function(){ submitReview(itemId, itemQ, itemCtx); });
    })(item.id, item.question, item.context || 'general');

    var dismissBtn = document.createElement('button');
    dismissBtn.style.cssText = 'padding:8px 14px;background:var(--white);border:1.5px solid var(--gray-200);border-radius:8px;color:var(--gray-500);font-family:var(--sans);font-size:var(--fs-sm);font-weight:500;cursor:pointer;';
    dismissBtn.textContent = 'Dismiss';
    (function(itemId){ dismissBtn.addEventListener('click', function(){ dismissReview(itemId); }); })(item.id);

    var statusSpan = document.createElement('span');
    statusSpan.id = 'review-status-' + item.id;
    statusSpan.style.cssText = 'font-size:var(--fs-xs);color:var(--gray-500);flex:1;';

    btnRow.appendChild(submitBtn);
    btnRow.appendChild(dismissBtn);
    btnRow.appendChild(statusSpan);
    body.appendChild(btnRow);

    card.appendChild(hdr);
    card.appendChild(body);
    list.appendChild(card);
  });
}


async function submitReview(id, question, context){
  var ansEl = document.getElementById('ans-'+id);
  var statusEl = document.getElementById('review-status-'+id);
  if(!ansEl || !ansEl.value.trim()){
    if(statusEl) statusEl.textContent = 'Please enter an answer.';
    return;
  }
  if(statusEl){ statusEl.textContent = 'Saving and applying...'; statusEl.style.color='var(--gray-400)'; }

  try{
    var result = await api('/reviews','POST',{
      action: 'resolve',
      id: id,
      question: question,
      context: context,
      answer: ansEl.value.trim(),
      resolved_by: getUserId(),
      resolved_by_name: window.currentNurse || 'Admin'
    });

    var appliedTo = result.applied_to || 'confirmation';
    var msg, color;
    if (appliedTo === 'kb') {
      msg = '✓ Answer added to Knowledge Base';
      color = 'var(--green)';
    } else if (appliedTo === 'kb_failed') {
      // The context was kb-eligible (kb_gap or protocol) but the
      // promotion to kb_entries failed server-side. The review row
      // IS saved with the answer, but the AI won't see it on the
      // next triage. Surface this loudly — don't let staff walk
      // away thinking the AI learned.
      msg = '⚠ Saved on review row, but failed to add to Knowledge Base. Re-try or add manually under KB → ' + (context === 'protocol' ? 'Protocols' : 'Rules & Notes') + '.';
      color = 'var(--amber)';
    } else if (appliedTo === 'correction') {
      msg = '✓ Saved as correction';
      color = 'var(--green)';
    } else {
      msg = '✓ Saved — confirms existing logic';
      color = 'var(--green)';
    }

    if(statusEl){ statusEl.textContent = msg; statusEl.style.color = color; }

    // Remove from list after short delay. If the answer DID reach
    // the KB, refresh the in-memory KB from the server so the next
    // triage actually uses the new knowledge. Earlier code just
    // called invalidateKBCache(), which reset the string cache but
    // left the kb global stale — the AI would keep using the old
    // KB until the staff member happened to open the KB tab.
    // Multi-day learning latency on the very loop we're trying to
    // close. loadKBFromServer is async; we don't await it because
    // the next triage may not be imminent, but it'll be in place
    // by the time it is.
    setTimeout(function(){
      var card = document.getElementById('review-'+id);
      if(card){ card.style.opacity='0'; card.style.transition='opacity .3s'; }
      setTimeout(function(){
        loadReviews();
        if(appliedTo === 'kb') {
          invalidateKBCache();
          loadKBFromServer();
        }
      }, 300);
    }, 1500);

  }catch(e){
    if(statusEl){ statusEl.textContent = 'Error: '+e.message; statusEl.style.color='var(--red)'; }
  }
}

async function dismissReview(id){
  try{
    await api('/reviews','POST',{ action:'dismiss', id:id });
    var card = document.getElementById('review-'+id);
    if(card){ card.style.opacity='0'; card.style.transition='opacity .3s'; }
    setTimeout(function(){ loadReviews(); }, 300);
  }catch(e){
    console.error('dismissReview:', e.message);
  }
}


function showToast(msg,type){
  var t=document.getElementById('saveToast');
  t.textContent=msg;
  t.style.background=type==='error'?'var(--red)':type==='warn'?'var(--amber)':'var(--green)';
  t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},2800);
}

function esc(str){
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

initAuth();
// KB loads on demand when tab is opened -- not on page init
// This prevents null-reference errors from KB DOM elements not being present
