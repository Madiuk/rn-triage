// Relai — Triage and Tasking
// app.js — all application logic
// BASE_PROMPT and DEFAULT_KB live in data/base-prompt.js and data/default-kb.js
// (loaded as plain <script> tags before this file in index.html).

const CLINICAL_CATS = [
  'Injection/Dosing','Side Effects','Severe Side Effects',
  'Medication Management','Stall/Lack of Results','General Inquiry'
];

const NON_CLINICAL_CATS = [
  '-- None --',
  'Billing/Payment','Shipment/Tracking','Account/Subscription',
  'Refund Request','General Inquiry','Complaint/Concern'
];

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

function getSession(){
  try{ return JSON.parse(localStorage.getItem('relai_session')||'null'); }catch(e){ return null; }
}
function getToken(){
  var s = getSession();
  return s ? s.access_token : null;
}
function getCompanyId(){
  if(!currentProfile) return null;
  var members = currentProfile.company_members;
  return members&&members[0]?members[0].company_id:null;
}
function getUserId(){
  return currentUser ? currentUser.id : null;
}



// Cache for KB section strings -- rebuilt only when KB changes
var kbCache = {};
var kbCacheKey = '';

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
var promptVersionCache = null;
var kbVersionCache = null;
function getPromptVersion(){
  if(promptVersionCache) return promptVersionCache;
  if(typeof BASE_PROMPT === 'undefined') return null;
  promptVersionCache = simpleHash(BASE_PROMPT);
  return promptVersionCache;
}
function getKBVersion(){
  if(kbVersionCache) return kbVersionCache;
  kbVersionCache = simpleHash(getFullKB());
  return kbVersionCache;
}

// classifyMessage / parseTriageJSON / computeUrgencyScore / formatDuration /
// levenshteinDistance are defined in data/triage-lib.js so they can be
// unit-tested in Node. Browser sees them as globals.

// Build the full KB string (every section, in stable order). Used as the
// second cache block in runTriage so Anthropic prompt caching can hit on
// every warm call. Stable key = stable cache. classifyMessage-driven
// per-message KB selection invalidates the cache and is no longer used
// for the live triage call.
function getFullKB(){
  var sections = [
    {key:'notes',       label:'CLINICAL RULES (read first)'},
    {key:'routing',     label:'ROUTING RULES'},
    {key:'sideeffects', label:'SIDE EFFECT GUIDANCE'},
    {key:'templates',   label:'RESPONSE TEMPLATES'},
    {key:'protocols',   label:'PROTOCOLS'},
    {key:'urls',        label:'URLS'}
  ];
  return sections.map(function(s){ return getKBSection(s.key, s.label); })
    .filter(Boolean).join('\n\n');
}

function getKBPrompt(msg){
  var types = msg ? classifyMessage(msg) : ['rules','routing','sideeffects','templates','protocols','urls'];
  var p = [];

  if(types.includes('rules'))
    p.push(getKBSection('notes','CLINICAL RULES (read first)'));
  if(types.includes('routing') || types.includes('routing_detail'))
    p.push(getKBSection('routing','ROUTING RULES'));
  if(types.includes('sideeffects'))
    p.push(getKBSection('sideeffects','SIDE EFFECT GUIDANCE'));
  if(types.includes('templates'))
    p.push(getKBSection('templates','RESPONSE TEMPLATES'));
  if(types.includes('protocols'))
    p.push(getKBSection('protocols','PROTOCOLS'));
  if(types.includes('urls'))
    p.push(getKBSection('urls','URLS'));

  return p.filter(Boolean).join('\n\n');
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
    var r = await fetch('/.netlify/functions/auth/profile',{
      headers:{'Authorization':'Bearer '+session.access_token}
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
      var members = currentProfile&&currentProfile.company_members;
      var tenantName = (members&&members[0]&&members[0].companies&&members[0].companies.name)
        || (currentProfile&&currentProfile.company_name)
        || tenantValue(currentProfile&&currentProfile.tenant, 'brand.name');
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
  var members = currentProfile&&currentProfile.company_members;
  var company = (members&&members[0]&&members[0].companies&&members[0].companies.name)
    || (currentProfile&&currentProfile.company_name)
    || tenantValue(currentProfile&&currentProfile.tenant, 'brand.name');
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
    }catch(e){}
  }
  localStorage.removeItem('relai_session');
  window.location.href = '/login.html';
}


async function api(endpoint,method,body){
  var token=getToken();
  var hdrs={'Content-Type':'application/json'};
  if(token) hdrs['Authorization']='Bearer '+token;
  var opts={method:method||'GET',headers:hdrs};
  if(body)opts.body=JSON.stringify(body);
  var r=await fetch('/.netlify/functions/kb'+endpoint,opts);
  return r.json().catch(function(){return{};});
}

async function loadKBFromServer(){
  try{
    setSyncBar('','Loading...');
    var rows=await api('/kb');
    if(Array.isArray(rows)&&rows.length>0){
      var nkb={sideeffects:[],templates:[],protocols:[],urls:[],routing:[],notes:[]};
      rows.forEach(function(row){
        var s = nkb[row.section] ? row.section : 'notes';
        nkb[s].push({name:row.name,text:row.content,nurse_name:row.nurse_name||'Unknown'});
      });
      kb=nkb; invalidateKBCache();
      setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
    }else{
      // Empty DB -- seed with defaults and save so rules are in Supabase
      setSyncBar('','First run -- seeding knowledge base...');
      await saveKBSilent();
      setSyncBar('synced','Knowledge base seeded . '+new Date().toLocaleTimeString());
    }
    renderKB();
  }catch(e){setSyncBar('error','Could not load -- using local defaults');renderKB();}
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
  var entries=[],pos=0;
  ['sideeffects','templates','protocols','urls','routing','notes'].forEach(function(section){
    (kb[section]||[]).forEach(function(entry){
      entries.push({section:section,name:entry.name,content:entry.text,position:pos++,nurse_name:entry.nurse_name||window.currentNurse||'Unknown',user_id:(currentUser&&currentUser.id)||null,updated_at:new Date().toISOString()});
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
  }catch(e){alert('Error: '+e.message);}
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
  }catch(e){setSyncBar('error','Sync failed');}
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
      draft_response:parsed.draft_response||''
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
  }catch(e){btn.textContent='Save';btn.disabled=false;}
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
  if(!nowOpen) document.getElementById('priorInput').value = '';
  document.getElementById('msgLabel').textContent = nowOpen ? 'Latest Reply' : 'Current Message';
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
    // Build user content -- include prior conversation if provided
  var prior = (document.getElementById('priorInput')||{}).value||'';
  prior = prior.trim();
  var userContent = prior
    ? 'PRIOR CONVERSATION CONTEXT (earlier thread -- for background only, do not respond to this directly):\n\n' + prior + '\n\n---\n\nLATEST PATIENT MESSAGE (triage and respond to this):\n\n' + msg
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
    var res=await fetch('/.netlify/functions/triage',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:600,system:systemBlocks,messages:[{role:'user',content:userContent}]})
    });
    var data=await res.json();
    if(data.error)throw new Error(typeof data.error==='string'?data.error:(data.error.message||JSON.stringify(data.error)));
    var raw=(data.content||[]).map(function(b){return b.text||'';}).join('');
    if(!raw)throw new Error('Empty response from API.');
    var parsed = parseTriageJSON(raw);
    // Telemetry envelope from the proxy. Prefer server-measured latency
    // (excludes the user's own network jitter); fall back to wall-clock
    // here when the proxy is older than this client.
    var relai = data._relai || {};
    var clientLatency = Date.now() - triageStarted;
    var telemetry = {
      model: relai.model || 'claude-sonnet-4-6',
      latency_ms: relai.latency_ms != null ? relai.latency_ms : clientLatency,
      cost_usd: relai.cost_usd != null ? relai.cost_usd : null,
      input_tokens:           relai.usage ? (relai.usage.input_tokens                || null) : null,
      output_tokens:          relai.usage ? (relai.usage.output_tokens               || null) : null,
      cache_creation_tokens:  relai.usage ? (relai.usage.cache_creation_input_tokens || null) : null,
      cache_read_tokens:      relai.usage ? (relai.usage.cache_read_input_tokens     || null) : null,
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
    saveHistoryRecord(parsed,msg,telemetry).then(function(id){
      currentHistoryId=id;
      // Save review request if AI flagged low confidence
      if(parsed.review_request && parsed.review_request.question){
        saveReviewRequest(parsed.review_request, msg, parsed.draft_response, id);
      }
    });
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
  var btn=document.getElementById('timeframeSaveBtn');
  // checkmark button — no text change needed
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
async function submitCorrection(){
  var actual=document.getElementById('correctionInput').value.trim();
  if(!actual){alert('Please paste the response you actually sent.');return;}
  var btn=document.getElementById('correctionSubmitBtn');
  var status=document.getElementById('correctionStatus');
  btn.disabled=true;btn.querySelector('span').textContent='Analyzing...';
  status.textContent='';status.className='learn-status';
  try{
    var aiDraft=document.getElementById('aiDraftText')?document.getElementById('aiDraftText').innerText:'';
    // Collect category corrections as additional context for the learning note
    var catPills=document.querySelectorAll('.cat-pill.sel-clin');
    var catNote='';
    if(catPills.length){
      var catVals=[].map.call(catPills,function(p){return p.getAttribute('data-val');}).join(', ');
      if(catVals) catNote='\n\nCategory selected by staff: '+catVals+'.';
    }
    var tfEl=document.getElementById('timeframeSelect');
    if(tfEl) catNote+=' Timeframe: '+tfEl.value+'.';
    var analyzeRes=await fetch('/.netlify/functions/kb/analyze',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-haiku-4-5',max_tokens:200,
        system:'Compare an AI draft clinical response with what the nurse actually sent. Output 2-3 sentences: what changed, what this reveals about the AI gap, one improvement suggestion. Plain text only.',
        messages:[{role:'user',content:'AI draft:\n'+aiDraft+'\n\nActual sent:\n'+actual+catNote}]
      })
    });
    var analyzeData=await analyzeRes.json();
    var note=(analyzeData.content||[]).map(function(b){return b.text||'';}).join('').trim();
    var duration = triageStartTime ? Math.round((Date.now()-triageStartTime)/1000) : null;
    var editDist = levenshteinDistance(aiDraft||'', actual||'');
    if(currentHistoryId)await api('/history','POST',{
      action:'save_actual',
      id:currentHistoryId,
      actual_response:actual,
      correction_note:note,
      session_duration_seconds:duration,
      edit_distance:editDist
    });
    status.textContent=note?'OK Saved. Learning note: "'+note.substring(0,90)+(note.length>90?'...':'')+'"':'OK Response saved.';
    status.className='learn-status success';
    document.getElementById('correctionInput').value='';
      }catch(e){status.textContent='Error: '+e.message;status.className='learn-status error';}
  finally{btn.disabled=false;btn.querySelector('span').textContent='Submit & Learn';}
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
  var hasSideEffect=d.clinical_routing_flag&&(d.clinical_routing_level||'none')!=='none';
  var aiClinCat=(d.clinical_category||'').trim();
  var aiNonClin=(d.non_clinical_items&&d.non_clinical_items.length)?d.non_clinical_items.join(', '):'';
  var _in=d.internal_note||'';
  var routedTo=d.routed_to||'Support Team';
  var hasNonClin=!!(d.non_clinical_flag&&d.non_clinical_items&&d.non_clinical_items.length);
  var isClinical=!!(aiClinCat&&aiClinCat!=='General/multiple');
  var taskType=hasNonClin&&isClinical?'Dual Task':hasNonClin?'Non-Clinical':'Clinical';

  // Build pills
  var ncCats=['Billing/Payment','Shipment/Tracking','Account/Subscription','Refund Request','General Inquiry','Complaint/Concern'];
  var clinPills=CLINICAL_CATS.map(function(c){
    var sel=c===aiClinCat;
    return '<button class="cat-pill'+(sel?' sel-clin':'')+'" data-val="'+esc(c)+'" data-type="clin">'+esc(c)+'</button>';
  }).join(' ');
  var ncPills=ncCats.map(function(c){
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

          // Severity badge — shown when the AI flagged a side effect
          (hasSideEffect&&isClinical?
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
            '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-700);margin-bottom:5px;">Internal Note &mdash; paste into Bask chat</div>'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-600);line-height:1.5;margin-bottom:8px;">Copy &rarr; open Bask chat &rarr; submit as internal note &rarr; assign to <strong>'+esc(routedTo)+'</strong></div>'+
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
      catSpan.textContent=r.clinical_category||'';

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
  }catch(e){list.innerHTML='<div class="empty-state" style="color:var(--red);">Error: '+esc(e.message)+'</div>';}
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
    var clinVals=[],ncVals=[];
    document.querySelectorAll('.cat-pill.sel-clin').forEach(function(p){clinVals.push(p.getAttribute('data-val'));});
    document.querySelectorAll('.cat-pill.sel-nc').forEach(function(p){ncVals.push(p.getAttribute('data-val'));});
    var tfSel=document.getElementById('timeframeSelect');
    var saves=[api('/history','POST',{action:'update_category',id:currentHistoryId,category:(clinVals.join(', ')||'')+(ncVals.length?' | Non-clinical: '+ncVals.join(', '):'')})];
    if(tfSel) saves.push(api('/history','POST',{action:'update_urgency',id:currentHistoryId,urgency_override:tfSel.value}));
    await Promise.all(saves);
    btn.textContent='Saved ✓'; btn.className='cat-save-btn saved';
    showToast('Categories saved');
    setTimeout(function(){btn.textContent='Save';btn.className='cat-save-btn';btn.disabled=false;},2000);
  }catch(e){
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
  } catch(e){ showToast('Error saving feedback'); }
}

async function loadHistory(){
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

    // Aggregate stats
    var total = rows.length;
    var escalated = rows.filter(function(r){return r.clinical_routing_level&&r.clinical_routing_level!=='none';}).length;
    var corrected = rows.filter(function(r){return r.actual_response_sent;}).length;
    var avgScore = rows.reduce(function(a,r){return a+(r.urgency_score||0);},0)/Math.max(total,1);
    var corrRate = Math.round((corrected/Math.max(total,1))*100);

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
      {label:'Correction Rate', val:corrRate+'%', color:corrRate>40?'var(--amber)':'var(--green)'},
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
      var s = byStaff[name] || (byStaff[name] = {count:0, scoreSum:0, corrected:0, escalated:0, durSum:0, durCount:0});
      s.count++;
      s.scoreSum += r.urgency_score||0;
      if(r.actual_response_sent) s.corrected++;
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
        corrRate: Math.round((s.corrected/s.count)*100),
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
              '<th class="num">Corrections</th>'+
              '<th class="num">Escalated</th>'+
              '<th class="num">Avg Time</th>'+
            '</tr></thead>'+
            '<tbody>'+
            staffRows.map(function(s){
              return '<tr>'+
                '<td class="staff-name">'+esc(s.name)+'</td>'+
                '<td class="num">'+s.count+'</td>'+
                '<td class="num">'+s.avgScore+'</td>'+
                '<td class="num">'+s.corrRate+'%</td>'+
                '<td class="num">'+s.escalated+'</td>'+
                '<td class="num">'+s.avgDur+'</td>'+
              '</tr>';
            }).join('')+
            '</tbody>'+
          '</table>'+
        '</div>';
    }

      // Triage queue table — sorted by priority score so the most pressing
    // tasks land at the top, exactly how the queue should behave when EHR
    // ingest starts pushing tasks in automatically.
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
    var sortedRows = filtered.slice().sort(function(a,b){
      var sa = a.urgency_score||0, sb = b.urgency_score||0;
      if(sb !== sa) return sb - sa;                 // higher score first
      return new Date(b.created_at) - new Date(a.created_at); // then newer first
    });
       var tableHtml =
      '<div class="data-table-wrap">'+
        '<div class="data-table-title">Recent Triages — sorted by priority</div>'+
        '<table class="data-table">'+
          '<thead><tr>'+
            '<th class="num">Score</th>'+
            '<th>Priority</th>'+
            '<th>Type</th>'+
            '<th>Date</th>'+
            '<th>Staff</th>'+
            '<th>Category</th>'+
            '<th>Urgency</th>'+
            '<th class="num">Corrected</th>'+
            '<th class="num">Time</th>'+
          '</tr></thead>'+
          '<tbody>'+
          sortedRows.slice(0,100).map(function(r){
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
            return '<tr>'+
              '<td class="num" style="font-weight:700;color:'+scoreColor+';">'+score+'</td>'+
              '<td style="color:'+tierColor[tier]+';font-weight:600;">'+tierLabel[tier]+'</td>'+
              '<td>'+shapeCell+'</td>'+
              '<td>'+dt+'</td>'+
              '<td class="staff-name">'+esc(r.nurse_name||'')+'</td>'+
              '<td>'+esc(r.clinical_category||'')+'</td>'+
              '<td>'+esc(urg)+'</td>'+
              '<td class="num">'+corrected+'</td>'+
              '<td class="num">'+dur+'</td>'+
            '</tr>';
          }).join('')+
          '</tbody>'+
        '</table>'+
      '</div>';

    list.innerHTML = staffHtml + tableHtml;
  }catch(e){
    list.innerHTML = '<div style="color:var(--red);padding:20px;">Error: '+esc(e.message)+'</div>';
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
  }catch(e){}
}

async function loadReviews(){
  try{
    var rows = await api('/reviews');
    var pending = Array.isArray(rows) ? rows.filter(function(r){return r.status==='pending';}) : [];
    updateReviewBadge(pending.length);
    window._pendingReviews = pending;
    renderReviews(pending);
  }catch(e){}
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
    var msg = appliedTo==='kb' ? '✓ Answer added to Knowledge Base' :
              appliedTo==='correction' ? '✓ Saved as correction' :
              '✓ Saved — confirms existing logic';

    if(statusEl){ statusEl.textContent = msg; statusEl.style.color='var(--green)'; }

    // Remove from list after short delay
    setTimeout(function(){
      var card = document.getElementById('review-'+id);
      if(card){ card.style.opacity='0'; card.style.transition='opacity .3s'; }
      setTimeout(function(){
        loadReviews();
        // If answer went to KB, refresh the KB if open
        if(appliedTo==='kb') invalidateKBCache();
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
  }catch(e){}
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
