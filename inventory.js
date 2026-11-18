(() => {
'use strict';
const $ = id => document.getElementById(id);

/* =========================================
   CHEMORA TOAST NOTIFICATION SYSTEM
   ========================================= */
function showToast(message, type = 'success') {
  if (!message) return;
  const container = $('chemoraToastContainer');
  if (!container) return;
  if (!['success', 'error', 'info'].includes(type)) type = 'info';

  const toast = document.createElement('div');
  toast.className = `chemora-toast ${type}`;

  const icon = document.createElement('span');
  icon.className = 'chemora-toast-icon';
  const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
  icon.innerHTML = `<i class="fa-solid ${icons[type]}"></i>`;

  const text = document.createElement('span');
  text.className = 'chemora-toast-message';
  text.textContent = message;

  const close = document.createElement('button');
  close.className = 'chemora-toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = '&times;';

  toast.append(icon, text, close);
  container.prepend(toast);

  let removed = false;
  let timer = null;
  function removeToast() {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 200);
  }
  close.addEventListener('click', removeToast);
  timer = setTimeout(removeToast, 4000);
}

// Chemora uses a permanent dark appearance.
document.documentElement.classList.add('inventory-dark');

const cfg = window.HARI_INVENTORY_CONFIG;
const clean = value => typeof value === 'string' ? value.trim() : value;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const show = (el, visible) => { if (el) el.classList.toggle('hide', !visible); };
const errorText = e => e?.message || String(e);
const optional = v => (v === '' || v === undefined) ? null : v;

/* Messages for the global status are shown as toasts; inline ids keep plain text. */
const status = (message, id = 'globalStatus') => {
  const el = $(id);
  if (!el) return;
  const text = String(message || '').trim();
  el.textContent = text;
  if (!text || id !== 'globalStatus') return;
  const isProgress = /^(loading|saving|signing in|searching|deleting|creating|updating|submitting|receiving|processing|fetching|identifying|exporting|importing)\b/i.test(text);
  if (isProgress) return;
  const isError = /\b(error|failed|failure|denied|cannot|can't|unable|invalid|not approved|not allowed|required|forbidden|unauthorized|not applied|exceed)\b/i.test(text);
  showToast(text, isError ? 'error' : 'success');
};

if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
  show($('setup'), true);
  show($('auth'), false);
  return;
}
const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

/* ---------- state ---------- */
let user = null, role = null, labContext = null;
let locations = [], ownerProfiles = [];
let lastChemicals = [], lastContainers = [], matchedContainerIds = null, lastSearch = null, searchSeq = 0;
let activeChemicalId = null, activeContainerId = null;
let cachedOrders = [], cachedHistory = [], historyNames = {}, cachedUsers = [];
let activeReceiveOrder = null, actionContainerId = null;
let importRows = [], importBusy = false, importSource = null;

const isManager = () => role === 'manager' || role === 'admin';
const isAdmin = () => role === 'admin';
const val = (f, k) => clean(new FormData(f).get(k));

/* ---------- data helpers ---------- */
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// PostgREST returns at most 1000 rows per request, so page through results (a stable order is required).
async function fetchAll(build, pageSize = 1000, max = 50000) {
  const rows = [];
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
async function fetchIn(table, column, ids, { select = '*', order = 'id' } = {}) {
  const rows = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    rows.push(...await fetchAll(() => db.from(table).select(select).in(column, part).order(order)));
  }
  return rows;
}
// An UPDATE blocked by row-level security succeeds with zero rows, so check that a row was really changed.
async function updateRow(table, id, patch) {
  const { data, error } = await db.from(table).update(patch).eq('id', id).select('id');
  if (error) return { error };
  if (!data || !data.length) return { error: new Error('Update was not applied (permission denied or record not found).') };
  return { error: null };
}
const likePattern = q => '%' + String(q).replace(/[\\%_]/g, '\\$&') + '%';
const isActiveContainer = x => x.status !== 'disposed';

function validCAS(value) {
  if (!/^\d{2,7}-\d{2}-\d$/.test(value)) return false;
  const digits = value.replace(/-/g, '');
  const check = Number(digits.slice(-1));
  const body = digits.slice(0, -1).split('').reverse();
  return body.reduce((sum, d, i) => sum + Number(d) * (i + 1), 0) % 10 === check;
}
function expiryLabel(x) {
  if (!x.expires_at) return 'Expiry not recorded';
  const d = new Date(x.expires_at + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 'Expiry not recorded';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  return days < 0 ? 'Expired' : days <= 30 ? 'Expires within 30 days' : 'Valid';
}
const fmtDate = x => x ? new Date(x).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// Cells beginning with = + - @ are executed as formulas by spreadsheet software; neutralise them.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function downloadCSV(filename, rows) {
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- session ---------- */
function resetState() {
  lastChemicals = []; lastContainers = []; matchedContainerIds = null; lastSearch = null; searchSeq++;
  activeChemicalId = null; activeContainerId = null; activeReceiveOrder = null; actionContainerId = null;
  cachedOrders = []; cachedHistory = []; historyNames = {}; cachedUsers = []; locations = []; ownerProfiles = [];
  importRows = []; importBusy = false; importSource = null; show($('importPanel'), false);
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  for (const id of ['chemicalCards', 'orderList', 'historyList', 'userList', 'toolsResult', 'locationList']) $(id)?.replaceChildren();
  $('chemoraResultsCount').textContent = '';
  show($('chemoraResultsPanel'), false);
  $('chemoraToastContainer')?.replaceChildren();
  labContext = null;
  show($('labSwitcher'), false); show($('createLabPanel'), false);
}
function showLoggedOut() {
  show($('auth'), true); show($('portal'), false); show($('profileCard'), false);
  $('who').textContent = '';
}
async function rejectSession(message) {
  user = null; role = null;
  await db.auth.signOut();
  resetState();
  showLoggedOut();
  status(message, 'loginError');
}
function applyRoleVisibility() {
  document.querySelectorAll('.manager-only').forEach(el => show(el, isManager()));
  document.querySelectorAll('.admin-only').forEach(el => show(el, isAdmin()));
  document.querySelectorAll('#mobileModule option').forEach(o => {
    const allowed = (!o.hasAttribute('data-manager') || isManager()) && (!o.hasAttribute('data-admin') || isAdmin());
    o.hidden = !allowed; o.disabled = !allowed;
  });
}
async function initSession() {
  const { data: { user: current }, error } = await db.auth.getUser();
  user = error ? null : current; role = null;
  let displayName = '';
  if (user) {
    const result = await db.rpc('inventory_my_context');
    if (result.error) { await rejectSession('Could not verify inventory access: ' + result.error.message); return; }
    if (!result.data?.lab_id || !result.data?.role) { await rejectSession('Your account is not approved for inventory access.'); return; }
    role = result.data.role;
    labContext = result.data;
    const { data: profile } = await db.from('inventory_user_profiles').select('full_name,account_status').eq('user_id', user.id).maybeSingle();
    if (profile?.account_status === 'locked') { await rejectSession('This account is locked. Contact the administrator.'); return; }
    displayName = profile?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';
  }
  if (!user) { resetState(); showLoggedOut(); return; }

  show($('auth'), false); show($('portal'), true); show($('profileCard'), true);
  $('who').textContent = displayName;
  $('profileRole').textContent = (role === 'admin' ? 'Administrator' : role === 'manager' ? 'Chemical Manager' : 'Member') + (labContext?.lab_name ? ' · ' + labContext.lab_name : '');
  $('profileAvatar').textContent = displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'HG';
  applyRoleVisibility();
  renderLabControls();
  setTab('home');
  $('chemicalCards').replaceChildren();
  show($('chemoraResultsPanel'), false);
  $('chemoraResultsCount').textContent = '';
  status('', 'searchStatus');
  await Promise.all([loadLocations(), loadContainerOwners()]);
}
/* Lab switcher and lab creation (data of different labs never mixes: the database only returns the selected lab). */
function renderLabControls() {
  const labs = labContext?.labs || [], sw = $('labSwitcher');
  sw.replaceChildren(...labs.map(l => new Option(l.name, l.id)));
  sw.value = labContext?.lab_id || '';
  show(sw, labs.length > 1);
  show($('createLabPanel'), Boolean(labContext?.platform_admin) && isAdmin());
}
async function switchLab(labId) {
  const { error } = await db.rpc('inventory_switch_lab', { p_lab_id: labId });
  if (error) { status(error.message); renderLabControls(); return false; }
  resetState();
  await initSession();
  return true;
}
$('labSwitcher').addEventListener('change', async e => {
  const select = e.currentTarget;
  select.disabled = true;
  try { if (await switchLab(select.value)) status('Switched to ' + (labContext?.lab_name || 'the selected lab') + '.'); }
  finally { select.disabled = false; }
});
$('labForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget, name = val(f, 'name'), prefix = val(f, 'prefix').toUpperCase();
  if (!name) return status('Lab name is required.');
  if (!/^[A-Z0-9]{1,8}$/.test(prefix)) return status('Barcode prefix must be 1-8 letters or numbers.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug.length < 2) return status('Use a lab name with at least two letters or numbers.');
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { data, error } = await db.rpc('inventory_create_lab', { p_name: name, p_slug: slug, p_prefix: prefix });
    if (error) return status(/duplicate key|already exists/i.test(error.message) ? 'A lab with that name already exists.' : error.message);
    f.reset();
    if (await switchLab(data)) status('Lab "' + name + '" created. You are now working in it.');
  } finally { submit.disabled = false; }
});
function setTab(name) {
  if (!$('view-' + name)) name = 'home';
  if ((name === 'history' && !isManager()) || (['users', 'tools'].includes(name) && !isAdmin())) return;
  document.querySelectorAll('.tab-view').forEach(el => show(el, el.id === 'view-' + name));
  $('portal').dataset.activeTab = name;
  if ($('mobileModule')) $('mobileModule').value = name;
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'requests') loadOrders();
  if (name === 'locations') loadLocations();
  if (name === 'history') loadHistory();
  if (name === 'users') loadUsers();
  if (name === 'add') loadContainerOwners();
}
$('mobileModule')?.addEventListener('change', e => setTab(e.target.value));
$('login').addEventListener('submit', async e => {
  e.preventDefault();
  const submit = e.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  status('Signing in…', 'loginError');
  try {
    const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    $('password').value = '';
    if (error) { status(error.message, 'loginError'); return; }
    status('', 'loginError');
    await initSession();
  } catch (err) {
    status(errorText(err), 'loginError');
  } finally {
    submit.disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  user = null; role = null;
  await db.auth.signOut();
  resetState();
  status('');
  await initSession();
});
// Session expired or ended in another tab: return to the sign-in form and drop cached data.
db.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_OUT' && user) {
    user = null; role = null;
    resetState(); showLoggedOut();
    status('Your session has ended. Please sign in again.', 'loginError');
  }
});
document.querySelectorAll('#tabs button[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('[data-open-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.openTab)));

/* ---------- locations ---------- */
const locationLevels = ['building', 'room', 'cabinet', 'shelf', 'position'];
function locationPath(l, seen = new Set()) {
  if (seen.has(l.id)) return l.name;
  seen.add(l.id);
  const parent = locations.find(x => x.id === l.parent_id);
  return parent ? locationPath(parent, seen) + ' / ' + l.name : l.name;
}
const activeLocations = () => [...locations].filter(l => l.active !== false).sort((a, b) => locationPath(a).localeCompare(locationPath(b)));
function refreshLocationParent() {
  const type = $('locationType')?.value;
  if (!$('locationParent')) return;
  const expected = locationLevels[locationLevels.indexOf(type) - 1];
  const options = locations.filter(l => l.location_type === expected && l.active !== false);
  $('locationParent').replaceChildren(new Option(expected ? 'Select parent' : 'No parent (building)', ''), ...options.map(l => new Option(locationPath(l), l.id)));
  $('locationParent').required = Boolean(expected);
  $('locationParent').disabled = !expected;
}
$('locationType')?.addEventListener('change', refreshLocationParent);
async function loadLocations() {
  const { data, error } = await db.from('inventory_locations').select('*').order('name');
  if (error) { status(error.message); return; }
  locations = data || [];
  const sorted = [...locations].sort((a, b) => locationPath(a).localeCompare(locationPath(b)));
  const prevSearch = $('searchLocation').value, prevAdd = $('chemicalLocation').value;
  $('chemicalLocation').replaceChildren(new Option('Select location', ''), ...sorted.filter(l => l.active !== false).map(l => new Option(locationPath(l), l.id)));
  $('searchLocation').replaceChildren(new Option('All locations', ''), ...sorted.map(l => new Option(locationPath(l), l.id)));
  $('chemicalLocation').value = prevAdd;
  $('searchLocation').value = prevSearch;
  refreshLocationParent();
  $('locationList').innerHTML = sorted.length ? sorted.map(l => `<details class="location-item"><summary><i class="fa-regular fa-folder"></i> ${esc(locationPath(l))} <span class="muted">${esc(l.barcode || 'Legacy location')}</span></summary><p>${esc(l.description || 'No description')}</p><p>Type: ${esc(l.location_type || 'room')} · ${l.active === false ? 'Inactive' : 'Active'}</p><p>Barcode: <code>${esc(l.barcode || '—')}</code></p>${isAdmin() ? `<div class="actions"><button type="button" class="btn secondary" data-edit-location="${esc(l.id)}">Edit</button><button type="button" class="btn secondary" data-toggle-location="${esc(l.id)}">${l.active === false ? 'Activate' : 'Deactivate'}</button></div>` : ''}</details>`).join('') : '<p class="muted">No locations yet.</p>';
}
$('locationList').addEventListener('click', async e => {
  if (!isAdmin()) return;
  const edit = e.target.closest('[data-edit-location]'), toggle = e.target.closest('[data-toggle-location]');
  const id = edit?.dataset.editLocation || toggle?.dataset.toggleLocation;
  if (!id) return;
  const loc = locations.find(x => x.id === id);
  if (!loc) return;
  let patch;
  if (edit) {
    const name = prompt('Location name', loc.name);
    if (name === null) return;
    if (!name.trim()) return status('Location name is required.');
    const clash = locations.some(x => x.id !== id && (x.parent_id || null) === (loc.parent_id || null) && x.name.toLowerCase() === name.trim().toLowerCase());
    if (clash) return status('Another location with this name already exists under the same parent.');
    const description = prompt('Description', loc.description || '');
    if (description === null) return;
    patch = { name: name.trim(), description: description.trim() || null };
  } else {
    const activating = loc.active === false;
    let note = '';
    if (!activating) {
      const { count } = await db.from('inventory_containers').select('id', { count: 'exact', head: true }).eq('location_id', id).or('status.is.null,status.neq.disposed');
      if (count) note = `\n\n${count} container(s) are stored here and will remain assigned to it.`;
    }
    if (!confirm((activating ? 'Activate' : 'Deactivate') + ' this location? Containers will not be moved.' + note)) return;
    patch = { active: activating };
  }
  const { error } = await updateRow('inventory_locations', id, patch);
  status(error ? error.message : 'Location updated.');
  if (!error) await loadLocations();
});
$('locationForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const type = val(f, 'location_type'), parent = optional(val(f, 'parent_id')), name = val(f, 'name');
  if (!name) return status('Location name is required.');
  if (type !== 'building' && !parent) return status('Choose a parent location.');
  if (locations.some(l => (l.parent_id || null) === (parent || null) && l.name.toLowerCase() === name.toLowerCase())) return status('A location with this name already exists under the same parent.');
  const { error } = await db.from('inventory_locations').insert({ name, description: optional(val(f, 'description')), location_type: type, parent_id: type === 'building' ? null : parent });
  status(error ? error.message : 'Location added.');
  if (!error) { f.reset(); await loadLocations(); }
});

/* ---------- search ---------- */
const structureUrl = c => 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' + encodeURIComponent(c.cas || c.name) + '/PNG?image_size=240x240';
function chemicalCard(c, x) {
  return `<button type="button" class="card chemical-result chemora-structure-card" data-chemical-id="${esc(c.id)}" ${x ? `data-container-id="${esc(x.id)}"` : ''} aria-label="View details for ${esc(c.name)}"><span class="chemora-structure-frame"><img src="${esc(structureUrl(c))}" alt="Chemical structure of ${esc(c.name)}" loading="lazy" onerror="this.style.display='none'"></span><span class="chemora-card-name"><strong>Name:</strong> ${esc(c.name)}</span></button>`;
}
function renderChemicalCards() {
  const locationId = $('searchLocation').value;
  const cards = lastChemicals.flatMap(c => {
    const rows = lastContainers.filter(x => x.chemical_id === c.id && (!locationId || x.location_id === locationId) && (!matchedContainerIds || matchedContainerIds.has(x.id)));
    if (rows.length) return rows.map(x => chemicalCard(c, x));
    return (locationId || matchedContainerIds) ? [] : [chemicalCard(c, null)];
  });
  $('chemicalCards').innerHTML = cards.join('') || '<p class="muted">No matching containers.</p>';
  if (!$('chemoraResultsPanel').classList.contains('hide')) $('chemoraResultsCount').textContent = `${cards.length} container/chemical card(s) found.`;
  return cards.length;
}
function clearResults() {
  searchSeq++;
  lastChemicals = []; lastContainers = []; matchedContainerIds = null; lastSearch = null;
  $('chemicalCards').replaceChildren();
  $('chemoraResultsCount').textContent = '';
  status('', 'searchStatus');
  show($('chemoraResultsPanel'), false);
}
$('searchLocation').addEventListener('change', () => {
  if ($('chemoraResultsPanel').classList.contains('hide') || !lastSearch) return;
  if (lastSearch.type === 'location') {
    if ($('searchLocation').value) loadChemicals('location', '');
    else clearResults();
  } else renderChemicalCards();
});

/* type: name | cas | barcode | location. For cas, q may be an array of exact CAS numbers. */
async function loadChemicals(type, q) {
  const seq = ++searchSeq;
  lastSearch = { type, q };
  show($('chemoraResultsPanel'), true);
  $('chemoraResultsCount').textContent = 'Searching…';
  status('Searching inventory…', 'searchStatus');
  try {
    let chemicals = [], containers = [], matched = null;
    if (type === 'barcode' || type === 'location') {
      const locationId = $('searchLocation').value;
      const hits = (await fetchAll(() => {
        const query = db.from('inventory_containers').select('*');
        return (type === 'barcode' ? query.ilike('barcode', likePattern(q)) : query.eq('location_id', locationId)).order('id');
      })).filter(isActiveContainer);
      matched = new Set(hits.map(x => x.id));
      const chemicalIds = [...new Set(hits.map(x => x.chemical_id))];
      chemicals = await fetchIn('inventory_chemicals', 'id', chemicalIds);
      containers = (await fetchIn('inventory_containers', 'chemical_id', chemicalIds)).filter(isActiveContainer);
    } else {
      if (type === 'cas') {
        chemicals = Array.isArray(q)
          ? await fetchIn('inventory_chemicals', 'cas', q)
          : await fetchAll(() => db.from('inventory_chemicals').select('*').ilike('cas', likePattern(q)).order('name').order('id'));
      } else {
        const byName = await fetchAll(() => db.from('inventory_chemicals').select('*').ilike('name', likePattern(q)).order('name').order('id'));
        const syn = await db.from('inventory_chemical_synonyms').select('chemical_id').ilike('synonym', likePattern(q)).limit(1000);
        const have = new Set(byName.map(c => c.id));
        const extraIds = syn.error ? [] : [...new Set((syn.data || []).map(x => x.chemical_id))].filter(id => !have.has(id));
        chemicals = byName.concat(await fetchIn('inventory_chemicals', 'id', extraIds));
      }
      containers = (await fetchIn('inventory_containers', 'chemical_id', chemicals.map(c => c.id))).filter(isActiveContainer);
    }
    if (seq !== searchSeq) return; // a newer search replaced this one
    chemicals.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    lastChemicals = chemicals; lastContainers = containers; matchedContainerIds = matched;
    renderChemicalCards();
    status('', 'searchStatus');
  } catch (err) {
    if (seq !== searchSeq) return;
    lastChemicals = []; lastContainers = []; matchedContainerIds = null;
    $('chemicalCards').replaceChildren();
    $('chemoraResultsCount').textContent = 'Search failed';
    status(errorText(err), 'searchStatus');
  }
}
$('search').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('searchChemicalName').value.trim();
  const cas = $('searchChemicalCas').value.trim();
  const barcode = $('searchChemicalBarcode').value.trim();
  const locationId = $('searchLocation').value;
  const filled = [name, cas, barcode].filter(Boolean).length;
  if (filled > 1) return showToast('Use only one search field at a time: Name, CAS Number, or Barcode.', 'error');
  if (filled === 0 && !locationId) return showToast('Enter a Chemical Name, CAS Number or Barcode, or choose a location to list its containers.', 'error');
  const type = name ? 'name' : cas ? 'cas' : barcode ? 'barcode' : 'location';
  const q = name || cas || barcode || '';
  $('type').value = type; $('query').value = q;
  await loadChemicals(type, q);
});
$('chemicalCards').addEventListener('click', e => {
  const card = e.target.closest('[data-chemical-id]');
  if (card) openChemical(card.dataset.chemicalId, card.dataset.containerId || null);
});

/* ---------- chemical details ---------- */
function openChemical(id, containerId = null) {
  const c = lastChemicals.find(x => x.id === id);
  if (!c) return;
  activeChemicalId = id;
  const allItems = lastContainers.filter(x => x.chemical_id === id);
  const selected = allItems.find(x => x.id === containerId) || allItems[0] || null;
  activeContainerId = selected?.id || null;
  const loc = locations.find(l => l.id === selected?.location_id);
  const display = (v, fallback = 'None') => esc(v === null || v === undefined || v === '' ? fallback : v);
  const row = (label, value, field = '', table = '') => `<div class="chemora-detail-row"><div class="chemora-detail-label"><strong>${label}</strong>${isManager() && field ? `<button type="button" class="chemora-detail-edit" data-inline-field="${field}" data-inline-table="${table}">Edit</button>` : ''}</div><div class="chemora-detail-value">${value}</div></div>`;
  const containerRows = allItems.map((x, i) => {
    const location = locations.find(l => l.id === x.location_id);
    return `<div class="chemical-container chemora-other-container"><strong>Container ${i + 1}${x.id === selected?.id ? ' (selected)' : ''}</strong><p>Barcode: ${display(x.barcode, '—')}</p><p>Location: ${display(location ? locationPath(location) : 'Unassigned')}</p><p>Size: ${display(x.container_size, '—')} ${display(x.unit, '')}</p><p>Remaining: ${display(x.remaining_amount, '—')} ${display(x.unit, '')}</p><p>Status: ${display(x.status, '—')}</p>${x.barcode ? `<button class="btn secondary" type="button" data-print-container="${esc(x.id)}">Print barcode label</button>` : ''}${isManager() ? `<button class="btn secondary" type="button" data-lifecycle="${esc(x.id)}">Manage container</button>` : ''}</div>`;
  }).join('');
  const expiry = selected?.expires_at ? `${display(selected.expires_at)} <span class="muted">(${esc(expiryLabel(selected))})</span>` : 'Not recorded';
  $('chemicalDialogTitle').textContent = c.name;
  $('chemicalDialogBody').innerHTML = `<div class="chemora-detail-grid">
   <div class="chemora-detail-column chemora-detail-left">
    <div class="chemora-detail-structure"><img src="${esc(structureUrl(c))}" alt="Structure of ${esc(c.name)}" onerror="this.style.display='none'"></div>
    <div class="chemora-ghs-summary"><h3>GHS Safety Summary</h3><p>GHS records have not been verified for this substance. Consult the supplier SDS and laboratory safety procedures.</p><a href="${esc('https://pubchem.ncbi.nlm.nih.gov/#query=' + encodeURIComponent(c.cas || c.name))}" target="_blank" rel="noopener noreferrer">View PubChem safety information</a></div>
   </div>
   <div class="chemora-detail-column chemora-detail-middle">
    ${row('Container Name', display(c.name), 'name', 'chemical')}
    ${row('CAS Number', display(c.cas), 'cas', 'chemical')}
    ${row('Barcode', display(selected?.barcode), selected ? 'barcode' : '', 'container')}
    ${row('Location', display(loc ? locationPath(loc) : 'Unassigned'), selected ? 'location_id' : '', 'container')}
    ${row('Container Size', `${display(selected?.container_size, '—')} ${display(selected?.unit, '')}`, selected ? 'container_size' : '', 'container')}
    ${row('Remaining Amount', `${display(selected?.remaining_amount, '—')} ${display(selected?.unit, '')}`, selected ? 'remaining_amount' : '', 'container')}
    ${row('Supplier', display(selected?.supplier), selected ? 'supplier' : '', 'container')}
    ${row('Date Acquired', display(selected?.received_at, 'Unknown'), selected ? 'received_at' : '', 'container')}
    ${row('Comments', display(selected?.notes || c.notes), 'notes', selected ? 'container' : 'chemical')}
   </div>
   <div class="chemora-detail-column chemora-detail-right">
    <div class="chemora-molecular-details">${row('Formula', display(c.formula, 'Not recorded'), 'formula', 'chemical')}${row('Status', display(selected?.status, 'Not recorded'))}${row('Ordered By', '<span data-ordered-by>Checking order record…</span>')}${row('Expiry', expiry, selected ? 'expires_at' : '', 'container')}</div>
    <div class="chemora-detail-links">${selected?.barcode ? `<button class="btn secondary" type="button" data-print-container="${esc(selected.id)}">Print Barcode Label</button>` : ''}${isManager() && selected ? `<button class="btn secondary" type="button" data-lifecycle="${esc(selected.id)}">Manage Container</button>` : ''}${isManager() ? '<button class="btn danger" type="button" data-delete-chemical-inline>Delete Chemical</button>' : ''}</div>
   </div>
  </div>
  ${allItems.length > 1 ? `<details class="chemora-all-containers"><summary>All registered containers (${allItems.length})</summary><div class="chemora-all-containers-list">${containerRows}</div></details>` : allItems.length === 0 ? '<p class="muted">No containers registered.</p>' : ''}`;
  if (!$('chemicalDialog').open) $('chemicalDialog').showModal();

  const orderedByElement = $('chemicalDialogBody').querySelector('[data-ordered-by]');
  if (orderedByElement) {
    if (!selected?.id) orderedByElement.textContent = 'Not recorded';
    else (async () => {
      try {
        const { data: order, error: orderError } = await db.from('inventory_orders').select('requested_by').eq('received_container_id', selected.id).limit(1).maybeSingle();
        if (orderError) throw orderError;
        let name = 'Not recorded';
        if (order?.requested_by) {
          const { data: profile, error: profileError } = await db.from('inventory_user_profiles').select('full_name').eq('user_id', order.requested_by).maybeSingle();
          if (profileError) throw profileError;
          name = profile?.full_name?.trim() || 'Name unavailable';
        }
        if (orderedByElement.isConnected && activeContainerId === selected.id) orderedByElement.textContent = name;
      } catch (err) {
        console.warn('Order requester lookup failed:', err);
        if (orderedByElement.isConnected && activeContainerId === selected.id) orderedByElement.textContent = 'Unavailable';
      }
    })();
  }
}

async function deleteActiveChemical() {
  if (!isManager() || !activeChemicalId) return showToast('Only Managers and Administrators can delete chemicals.', 'error');
  const id = activeChemicalId;
  const chemical = lastChemicals.find(c => c.id === id);
  if (!chemical) return showToast('Chemical not found.', 'error');
  try {
    // Fetch every container (including disposed ones) directly from the database.
    const containers = await fetchAll(() => db.from('inventory_containers').select('id,status').eq('chemical_id', id).order('id'));
    const nonDisposed = containers.filter(isActiveContainer);
    if (nonDisposed.length) return showToast(`Cannot permanently delete "${chemical.name}". ${nonDisposed.length} container(s) are not disposed.`, 'error');
    const confirmed = confirm(`Permanently delete "${chemical.name}"?\n\n` +
      (containers.length ? `${containers.length} disposed container(s) will also be deleted.\nTheir event history will be archived.\n\n` : 'No associated containers exist.\n\n') +
      'This action cannot be undone.\n\nContinue?');
    if (!confirmed) return;
    const typed = prompt(`Final confirmation:\n\nType DELETE to permanently remove "${chemical.name}".`);
    if (typed !== 'DELETE') { if (typed !== null) showToast('Deletion cancelled.', 'info'); return; }
    status('Deleting chemical…');
    const { error } = await db.rpc('inventory_delete_chemical', { p_chemical_id: id });
    if (error) throw error;
    lastChemicals = lastChemicals.filter(c => c.id !== id);
    lastContainers = lastContainers.filter(c => c.chemical_id !== id);
    activeChemicalId = null; activeContainerId = null;
    renderChemicalCards();
    $('chemicalDialog').close();
    showToast('Chemical and disposed containers permanently deleted. Event history archived.', 'success');
  } catch (err) {
    console.error('Permanent deletion failed:', err);
    showToast('Deletion failed: ' + errorText(err), 'error');
  }
}

/* Inline editing, labels and container actions inside the details popup */
async function saveInlineField(rowEl, saveButton) {
  const field = rowEl.dataset.editField, table = rowEl.dataset.editTable;
  const record = table === 'chemical' ? lastChemicals.find(x => x.id === activeChemicalId) : lastContainers.find(x => x.id === activeContainerId);
  if (!record) return;
  let value = rowEl.querySelector('.chemora-inline-input').value.trim();
  if (field === 'name' && !value) return status('Chemical name is required.');
  if (field === 'cas' && value && !validCAS(value)) return status('Invalid CAS number (checksum failed).');
  if (field === 'location_id' && !value) return status('Choose a storage location.');
  if (['container_size', 'remaining_amount'].includes(field)) {
    if (value === '') {
      if (field === 'container_size') return status('Container size is required.');
      value = null;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || (field === 'container_size' && n <= 0)) return status('Enter a valid positive container size or non-negative remaining amount.');
      value = n;
    }
    if (field === 'remaining_amount' && value !== null && record.container_size != null && value > Number(record.container_size)) return status('Remaining amount cannot exceed the container size.');
    if (field === 'container_size' && record.remaining_amount != null && Number(record.remaining_amount) > value) return status('Container size cannot be smaller than the remaining amount.');
  } else if (value === '') value = null;
  if (field === 'expires_at' && value && record.received_at && value < record.received_at) return status('Expiry cannot precede receipt.');
  if (field === 'received_at' && value && record.expires_at && record.expires_at < value) return status('Receipt date cannot be after the expiry date.');

  saveButton.disabled = true;
  const patch = { [field]: value };
  let error;
  if (table === 'chemical') ({ error } = await updateRow('inventory_chemicals', record.id, patch));
  else if (field === 'location_id') ({ error } = await db.rpc('inventory_container_action_phase3', { p_id: record.id, p_action: 'move', p: { location_id: value } }));
  else if (field === 'remaining_amount' && value !== null) ({ error } = await db.rpc('inventory_container_action_phase3', { p_id: record.id, p_action: 'quantity', p: { remaining_amount: String(value) } }));
  else ({ error } = await updateRow('inventory_containers', record.id, patch));
  if (error) { saveButton.disabled = false; status(error.message); return; }
  if (table === 'container') {
    const fresh = await db.from('inventory_containers').select('*').eq('id', record.id).maybeSingle();
    Object.assign(record, fresh.data || patch);
  } else Object.assign(record, patch);
  renderChemicalCards();
  openChemical(activeChemicalId, activeContainerId);
  status('Field updated.');
}
$('chemicalDialogBody').addEventListener('click', async e => {
  const printBtn = e.target.closest('[data-print-container]');
  if (printBtn) return printContainerLabel(printBtn.dataset.printContainer);
  const lifecycleBtn = e.target.closest('[data-lifecycle]');
  if (lifecycleBtn) { if (isManager()) openContainerAction(lifecycleBtn.dataset.lifecycle); return; }
  if (e.target.closest('[data-delete-chemical-inline]')) return deleteActiveChemical();

  const edit = e.target.closest('[data-inline-field]'), cancel = e.target.closest('[data-inline-cancel]'), save = e.target.closest('[data-inline-save]');
  if (!isManager() || (!edit && !cancel && !save)) return;
  const rowEl = e.target.closest('.chemora-detail-row');
  if (!rowEl) return;
  if (cancel) return openChemical(activeChemicalId, activeContainerId);
  if (save) return saveInlineField(rowEl, save);

  // Only one inline editor at a time: re-render to discard any other open editor first.
  if ($('chemicalDialogBody').querySelector('.chemora-detail-row[data-edit-field]')) {
    openChemical(activeChemicalId, activeContainerId);
    $('chemicalDialogBody').querySelector(`[data-inline-field="${edit.dataset.inlineField}"][data-inline-table="${edit.dataset.inlineTable}"]`)?.click();
    return;
  }
  const field = edit.dataset.inlineField, table = edit.dataset.inlineTable;
  const record = table === 'chemical' ? lastChemicals.find(x => x.id === activeChemicalId) : lastContainers.find(x => x.id === activeContainerId);
  if (!record) return;
  const value = record[field] ?? '';
  const inputHtml = field === 'location_id'
    ? `<select class="chemora-inline-input">${activeLocations().concat(locations.filter(l => l.active === false && l.id === value)).map(l => `<option value="${esc(l.id)}" ${l.id === value ? 'selected' : ''}>${esc(locationPath(l))}</option>`).join('')}</select>`
    : field === 'notes'
      ? `<textarea class="chemora-inline-input" rows="3">${esc(value)}</textarea>`
      : `<input class="chemora-inline-input" type="${['container_size', 'remaining_amount'].includes(field) ? 'number' : ['received_at', 'expires_at'].includes(field) ? 'date' : 'text'}" ${['container_size', 'remaining_amount'].includes(field) ? 'min="0" step="any"' : ''} value="${esc(value)}">`;
  rowEl.dataset.editField = field;
  rowEl.dataset.editTable = table;
  rowEl.querySelector('.chemora-detail-value').innerHTML = `${inputHtml}<div class="chemora-inline-actions"><button type="button" class="btn" data-inline-save>Save</button><button type="button" class="btn secondary" data-inline-cancel>Cancel</button></div>`;
  edit.disabled = true;
  rowEl.querySelector('.chemora-inline-input')?.focus();
});
$('closeChemicalDialog').addEventListener('click', () => $('chemicalDialog').close());
$('chemicalDialog').addEventListener('click', e => { if (e.target === $('chemicalDialog')) $('chemicalDialog').close(); });

/* Phase 7: client-side printable Code 128 label. Never send container data to third parties. */
function printContainerLabel(containerId) {
  const container = lastContainers.find(x => x.id === containerId);
  if (!container || !container.barcode) return;
  const chemical = lastChemicals.find(x => x.id === container.chemical_id);
  $('phase7LabelName').textContent = chemical?.name || 'Chemical';
  $('phase7LabelCas').textContent = chemical?.cas ? 'CAS: ' + chemical.cas : 'CAS not recorded';
  $('phase7LabelCode').textContent = container.barcode;
  $('phase7LabelLocation').textContent = locations.find(l => l.id === container.location_id)?.name || 'Location not assigned';
  $('phase7LabelAmount').textContent = String(container.container_size ?? '') + ' ' + (container.unit || '');
  const svg = $('phase7Barcode'); svg.replaceChildren();
  if (typeof window.JsBarcode === 'function') {
    try {
      window.JsBarcode(svg, container.barcode, { format: 'CODE128', displayValue: false, width: 1.5, height: 58, margin: 5, background: '#fff', lineColor: '#000' });
      $('phase7LabelWarning').textContent = 'Scan the barcode before attaching this label.';
    } catch (err) { $('phase7LabelWarning').textContent = 'Barcode graphic unavailable: ' + errorText(err); }
  } else $('phase7LabelWarning').textContent = 'Barcode library unavailable. The text identifier can still be printed.';
  $('phase7LabelDialog').showModal();
}
$('phase7CloseLabel').addEventListener('click', () => $('phase7LabelDialog').close());
$('phase7PrintLabel').addEventListener('click', () => window.print());

/* Container lifecycle (quantity / move / transfer / empty / dispose) */
function populateOwnerSelects() {
  const options = ownerProfiles.map(x => new Option(x.full_name || 'Unnamed user', x.user_id));
  $('containerOwner')?.replaceChildren(new Option('Current user', ''), ...options.map(o => o.cloneNode(true)));
  $('receiveOwner')?.replaceChildren(new Option('Receiving Manager', ''), ...options.map(o => o.cloneNode(true)));
}
async function loadContainerOwners() {
  const { data, error } = await db.from('inventory_user_profiles').select('user_id,full_name,account_status').or('account_status.is.null,account_status.neq.locked').limit(1000);
  if (error) return;
  ownerProfiles = (data || []).sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')));
  populateOwnerSelects();
}
function syncContainerActionFields() {
  const action = $('containerActionType').value;
  $('containerActionForm').querySelectorAll('[data-action-field]').forEach(el => show(el, el.dataset.actionField === action));
}
$('containerActionType').addEventListener('change', syncContainerActionFields);
function openContainerAction(id) {
  const x = lastContainers.find(z => z.id === id);
  if (!x || !isManager()) return;
  actionContainerId = id;
  const chemical = lastChemicals.find(c => c.id === x.chemical_id);
  const f = $('containerActionForm');
  f.reset();
  $('containerActionSummary').textContent = `${chemical?.name || 'Chemical'} — barcode ${x.barcode || 'not assigned'}`;
  f.elements.namedItem('remaining_amount').value = x.remaining_amount ?? '';
  f.elements.namedItem('location_id').replaceChildren(...activeLocations().concat(locations.filter(l => l.active === false && l.id === x.location_id)).map(l => new Option(locationPath(l), l.id)));
  f.elements.namedItem('location_id').value = x.location_id || '';
  f.elements.namedItem('owner_id').replaceChildren(...ownerProfiles.map(p => new Option(p.full_name || 'Unnamed user', p.user_id)));
  f.elements.namedItem('owner_id').value = x.owner_id || '';
  status('', 'containerActionStatus');
  syncContainerActionFields();
  $('containerActionDialog').showModal();
}
$('closeContainerAction').addEventListener('click', () => $('containerActionDialog').close());
$('containerActionForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isManager()) return;
  const f = e.currentTarget;
  const x = lastContainers.find(z => z.id === actionContainerId);
  if (!x) return;
  const action = val(f, 'action'), payload = {};
  const msg = text => status(text, 'containerActionStatus');
  if (action === 'quantity') {
    const raw = val(f, 'remaining_amount');
    if (raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) return msg('Enter a non-negative remaining quantity.');
    if (x.container_size != null && Number(raw) > Number(x.container_size)) return msg('Remaining quantity cannot exceed the container size.');
    payload.remaining_amount = raw;
  } else if (action === 'move') {
    const loc = val(f, 'location_id');
    if (!loc) return msg('Choose a destination location.');
    if (loc === x.location_id) return msg('The container is already at this location.');
    payload.location_id = loc;
  } else if (action === 'transfer') {
    const owner = val(f, 'owner_id');
    if (!owner) return msg('Choose the new owner.');
    if (owner === x.owner_id) return msg('This user already owns the container.');
    payload.owner_id = owner;
  } else if (action === 'dispose' && !confirm('Archive this container as disposed? This cannot be undone from the interface.')) return;
  else if (action === 'empty' && !confirm('Mark this container as empty?')) return;

  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await db.rpc('inventory_container_action_phase3', { p_id: x.id, p_action: action, p: payload });
    if (error) throw error;
    if (action === 'dispose') lastContainers = lastContainers.filter(z => z.id !== x.id);
    else {
      const fresh = await db.from('inventory_containers').select('*').eq('id', x.id).maybeSingle();
      if (fresh.data) Object.assign(x, fresh.data);
    }
    $('containerActionDialog').close();
    renderChemicalCards();
    openChemical(activeChemicalId, action === 'dispose' ? null : x.id);
    status('Container ' + action + ' recorded.');
  } catch (err) {
    msg(errorText(err));
  } finally {
    submit.disabled = false;
  }
});

/* ---------- add container ---------- */
$('addChemical').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const msg = text => status(text, 'addStatus');
  const name = val(f, 'name'), cas = val(f, 'cas'), size = Number(val(f, 'container_size')), rawAmount = val(f, 'remaining_amount');
  if (!name) return msg('Chemical name is required.');
  if (cas && !validCAS(cas)) return msg('Invalid CAS checksum.');
  if (!(size > 0) || !Number.isFinite(size)) return msg('Container size must be positive.');
  if (rawAmount !== '' && (!Number.isFinite(Number(rawAmount)) || Number(rawAmount) < 0 || Number(rawAmount) > size)) return msg('Remaining amount must be between zero and container size.');
  if (!val(f, 'location_id')) return msg('Choose a storage location.');
  if (val(f, 'received_at') && val(f, 'expires_at') && val(f, 'expires_at') < val(f, 'received_at')) return msg('Expiry cannot precede receipt.');
  const fields = ['name', 'cas', 'formula', 'supplier', 'catalog_number', 'lot_number', 'purity', 'unit', 'location_id', 'owner_id', 'received_at', 'expires_at', 'notes'];
  const payload = Object.fromEntries(fields.map(k => [k, optional(val(f, k))]));
  payload.name = name;
  payload.container_size = size;
  payload.remaining_amount = rawAmount === '' ? null : Number(rawAmount);
  payload.chemical_notes = '';
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  msg('Registering container…');
  try {
    const { data, error } = await db.rpc('inventory_register_container_phase3', { p: payload });
    if (error) throw error;
    f.reset();
    $('registeredBarcode').textContent = data?.barcode ? 'New container barcode: ' + data.barcode : '';
    msg('Container registered.' + (data?.same_location_count ? ' Warning: ' + data.same_location_count + ' existing container(s) of this chemical are already at that location.' : ''));
    if (!$('chemoraResultsPanel').classList.contains('hide')) clearResults(); // cached search results are now stale
  } catch (err) {
    msg(errorText(err));
  } finally {
    submit.disabled = false;
  }
});

/* ---------- orders ---------- */
$('orderForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const name = val(f, 'chemical_name'), cas = val(f, 'cas'), size = Number(val(f, 'container_size'));
  if (!name) return status('Chemical name is required.');
  if (cas && !validCAS(cas)) return status('Invalid CAS checksum.');
  if (!Number.isFinite(size) || size <= 0) return status('Enter a positive container size.');
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await db.from('inventory_orders').insert({ chemical_name: name, cas: optional(cas), container_size: size, unit: val(f, 'unit'), supplier: optional(val(f, 'supplier')), comments: optional(val(f, 'comments')), requested_by: user.id });
    if (error) return status(error.message);
    f.reset();
    status('Order request submitted.');
    loadOrders();
  } finally { submit.disabled = false; }
});
function renderOrders() {
  const q = $('orderFilter').value.trim().toLowerCase(), state = $('orderStatusFilter').value;
  const filtered = cachedOrders.filter(o => ['requested', 'ordered'].includes(o.status) && (!state || o.status === state) && (!q || [o.chemical_name, o.cas, o.supplier, o.status, o.comments].some(v => String(v || '').toLowerCase().includes(q))));
  const btn = (action, id, title, icon) => `<button type="button" class="btn secondary chemora-order-icon" data-order-action="${action}" data-order-id="${esc(id)}" title="${title}" aria-label="${title}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
  $('orderList').innerHTML = `<table class="inventory-data-table chemora-orders-table">
<thead><tr><th>Chemical Name</th><th>CAS Number</th><th>Size</th><th>Requested by</th><th>Requested on</th><th>Ordered on</th><th>Actions</th></tr></thead>
<tbody>${filtered.map(o => `<tr>
<td>${esc(o.chemical_name)}${o.received_container_id ? `<div class="muted">Container: ${esc(o.received_container_id)}</div>` : ''}</td>
<td>${esc(o.cas || '—')}</td>
<td>${esc(o.container_size)} ${esc(o.unit)}</td>
<td>${esc(o.requester_name || 'Name unavailable')}</td>
<td>${esc(fmtDate(o.requested_at))}</td>
<td>${esc(fmtDate(o.ordered_at))}</td>
<td class="row-actions"><div class="chemora-order-actions">
${btn('info', o.id, 'Order information', 'fa-circle-info')}
${o.status === 'requested' && isManager() ? btn('edit', o.id, 'Edit request', 'fa-pen') : ''}
${o.status === 'requested' && isManager() ? btn('ordered', o.id, 'Mark as ordered', 'fa-cart-shopping') : ''}
${o.status === 'ordered' && isManager() ? btn('receive', o.id, 'Receive and add to inventory', 'fa-box-open') + btn('undo', o.id, 'Undo order', 'fa-rotate-left') : ''}
${o.status === 'requested' && (isManager() || o.requested_by === user?.id) ? btn('cancel', o.id, 'Cancel request', 'fa-xmark') : ''}
</div></td></tr>`).join('')}</tbody></table>${filtered.length ? '' : '<p class="muted chemora-no-orders">No Order on Request.</p>'}`;
}
async function attachRequesterNames(orders) {
  const ids = [...new Set(orders.map(o => o.requested_by).filter(Boolean))];
  let names = new Map();
  if (ids.length) {
    try {
      const profiles = await fetchIn('inventory_user_profiles', 'user_id', ids, { select: 'user_id,full_name', order: 'user_id' });
      names = new Map(profiles.map(p => [p.user_id, p.full_name?.trim()]));
    } catch (_e) { /* fall back to the signed-in user's own name below */ }
  }
  orders.forEach(o => { o.requester_name = names.get(o.requested_by) || (o.requested_by === user?.id ? $('who').textContent : 'Name unavailable'); });
}
async function loadOrders() {
  try {
    // Only open orders are listed; fetching by status (not "latest 500") keeps old open orders from dropping off.
    cachedOrders = await fetchAll(() => db.from('inventory_orders').select('*').in('status', ['requested', 'ordered']).order('requested_at', { ascending: false }).order('id'));
    await attachRequesterNames(cachedOrders);
    renderOrders();
  } catch (err) { status(errorText(err)); }
}
$('orderFilter').addEventListener('input', renderOrders);
$('orderStatusFilter').addEventListener('change', renderOrders);
$('orderList').addEventListener('click', async e => {
  const b = e.target.closest('[data-order-action]');
  if (!b) return;
  const o = cachedOrders.find(x => String(x.id) === b.dataset.orderId);
  if (!o) return;
  const action = b.dataset.orderAction;
  if (action === 'info') { alert(`Chemical: ${o.chemical_name}\nCAS: ${o.cas || '—'}\nSupplier: ${o.supplier || '—'}\nSize: ${o.container_size} ${o.unit}\nStatus: ${o.status}\nComments: ${o.comments || '—'}`); return; }
  if (action === 'edit' && o.status === 'requested' && isManager()) {
    const f = $('editOrderForm'); f.reset();
    for (const key of ['chemical_name', 'cas', 'container_size', 'unit', 'supplier', 'comments']) f.elements.namedItem(key).value = o[key] ?? '';
    f.elements.namedItem('order_id').value = o.id;
    status('', 'editOrderStatus');
    $('editOrderDialog').showModal();
    return;
  }
  if (['ordered', 'undo', 'cancel'].includes(action)) {
    if (!confirm(`Confirm ${action} for ${o.chemical_name}?`)) return;
    const { error } = await db.rpc('inventory_order_action_phase4', { p_order_id: o.id, p_action: action, p: {} });
    status(error ? error.message : 'Order updated.');
    if (!error) await loadOrders();
    return;
  }
  if (action === 'receive' && isManager()) {
    activeReceiveOrder = o;
    $('receiveOrderSummary').textContent = `${o.chemical_name} — ${o.container_size} ${o.unit} (CAS: ${o.cas || 'none'})`;
    const f = $('receiveOrderForm'); f.reset();
    f.elements.namedItem('received_at').value = new Date().toLocaleDateString('en-CA');
    f.elements.namedItem('supplier').value = o.supplier || '';
    f.elements.namedItem('location_id').replaceChildren(new Option('Choose an active storage location', ''), ...activeLocations().map(l => new Option(locationPath(l), l.id)));
    status('', 'receiveOrderStatus');
    $('receiveOrderDialog').showModal();
  }
});
$('closeEditOrder').addEventListener('click', () => $('editOrderDialog').close());
$('cancelEditOrder').addEventListener('click', () => $('editOrderDialog').close());
$('editOrderForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isManager()) return;
  const f = e.currentTarget, orderId = val(f, 'order_id');
  const size = Number(val(f, 'container_size')), cas = val(f, 'cas');
  const msg = text => status(text, 'editOrderStatus');
  if (!val(f, 'chemical_name')) return msg('Chemical name is required.');
  if (cas && !validCAS(cas)) return msg('Invalid CAS checksum.');
  if (!Number.isFinite(size) || size <= 0) return msg('Enter a positive container size.');
  const p = { chemical_name: val(f, 'chemical_name'), cas: optional(cas), container_size: size, unit: val(f, 'unit'), supplier: optional(val(f, 'supplier')), comments: optional(val(f, 'comments')) };
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await db.rpc('inventory_edit_order_phase5', { p_order_id: orderId, p });
    if (error) throw error;
    $('editOrderDialog').close();
    status('Request updated.');
    await loadOrders();
  } catch (err) { msg(errorText(err)); } finally { submit.disabled = false; }
});
$('closeReceiveOrder').addEventListener('click', () => $('receiveOrderDialog').close());
$('receiveOrderForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isManager() || !activeReceiveOrder) return;
  const f = e.currentTarget, msg = text => status(text, 'receiveOrderStatus');
  const payload = {};
  for (const key of ['location_id', 'owner_id', 'received_at', 'expires_at', 'remaining_amount', 'supplier', 'catalog_number', 'lot_number', 'purity', 'notes']) payload[key] = val(f, key) || null;
  if (!payload.location_id) return msg('Choose a storage location.');
  if (payload.expires_at && payload.received_at && payload.expires_at < payload.received_at) return msg('Expiry cannot precede receipt.');
  if (payload.remaining_amount !== null) {
    const remaining = Number(payload.remaining_amount);
    if (!Number.isFinite(remaining) || remaining < 0) return msg('Remaining quantity must be zero or more.');
    if (remaining > Number(activeReceiveOrder.container_size)) return msg('Remaining quantity cannot exceed the container size.');
  }
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  msg('Registering received container…');
  try {
    const { data, error } = await db.rpc('inventory_order_action_phase4', { p_order_id: activeReceiveOrder.id, p_action: 'receive', p: payload });
    if (error) throw error;
    $('receiveOrderDialog').close();
    status(`Received and added to inventory. Barcode: ${data?.barcode ?? '—'}`);
    activeReceiveOrder = null;
    if (!$('chemoraResultsPanel').classList.contains('hide')) clearResults();
    await loadOrders();
  } catch (err) { msg(errorText(err)); } finally { submit.disabled = false; }
});
$('exportPendingOrders').addEventListener('click', () => {
  if (!isManager()) return;
  downloadCSV('hari-pending-orders.csv', [['Chemical', 'CAS', 'Size', 'Unit', 'Supplier', 'Status', 'Requested at', 'Requested by', 'Comments'],
    ...cachedOrders.filter(o => o.status === 'requested' || o.status === 'ordered').map(o => [o.chemical_name, o.cas, o.container_size, o.unit, o.supplier, o.status, o.requested_at, o.requester_name || o.requested_by, o.comments])]);
});
$('exportOrders').addEventListener('click', async () => {
  if (!isManager()) return;
  try {
    // The list shows open orders only; the full export includes received and cancelled ones as well.
    const all = await fetchAll(() => db.from('inventory_orders').select('*').order('requested_at', { ascending: false }).order('id'));
    await attachRequesterNames(all);
    downloadCSV('hari-orders.csv', [['Chemical', 'CAS', 'Size', 'Unit', 'Supplier', 'Status', 'Requested at', 'Ordered at', 'Received at', 'Requested by', 'Comments'],
      ...all.map(o => [o.chemical_name, o.cas, o.container_size, o.unit, o.supplier, o.status, o.requested_at, o.ordered_at, o.received_at, o.requester_name || 'Name unavailable', o.comments])]);
    status(`Exported ${all.length} orders.`);
  } catch (err) { status(errorText(err)); }
});
$('orderSettingsButton').addEventListener('click', () => {
  if (!isManager()) return;
  try { $('orderNotifyEmails').value = localStorage.getItem('hari-order-emails') || ''; } catch (_) { /* storage unavailable */ }
  $('orderSettingsDialog').showModal();
});
$('closeOrderSettings').addEventListener('click', () => $('orderSettingsDialog').close());
$('saveOrderSettings').addEventListener('click', () => {
  if (!isManager()) return;
  try { localStorage.setItem('hari-order-emails', $('orderNotifyEmails').value); $('orderSettingsStatus').textContent = 'Saved on this browser only. Email notifications are not enabled.'; }
  catch (e) { $('orderSettingsStatus').textContent = e.message; }
});

/* ---------- history ---------- */
function renderHistory() {
  const q = $('historyFilter').value.trim().toLowerCase(), from = $('historyFrom').value, to = $('historyTo').value;
  const items = cachedHistory.filter(x => {
    const day = String(x.created_at || '').slice(0, 10);
    return (!from || day >= from) && (!to || day <= to) && (!q || [x.table_name, x.action, historyNames[x.performed_by], x.performed_by].some(v => String(v || '').toLowerCase().includes(q)));
  });
  $('historyList').innerHTML = '<table class="inventory-data-table"><thead><tr><th>Timestamp (UTC)</th><th>Subject</th><th>Event</th><th>Performed by</th></tr></thead><tbody>' + items.map(x => `<tr><td>${esc(x.created_at)}</td><td>${esc(x.table_name)}</td><td>${esc(x.action)}</td><td>${esc(historyNames[x.performed_by] || x.performed_by || 'Unknown')}</td></tr>`).join('') + '</tbody></table>';
}
async function loadHistory() {
  if (!isManager()) return;
  const { data, error } = await db.from('inventory_activity_logs').select('created_at,table_name,action,performed_by').order('created_at', { ascending: false }).limit(1000);
  if (error) { status(error.message); return; }
  cachedHistory = data || [];
  const ids = [...new Set(cachedHistory.map(x => x.performed_by).filter(Boolean))];
  historyNames = {};
  if (ids.length) {
    try {
      const profiles = await fetchIn('inventory_user_profiles', 'user_id', ids, { select: 'user_id,full_name,email', order: 'user_id' });
      for (const p of profiles) historyNames[p.user_id] = p.full_name || p.email;
    } catch (_e) { /* names are optional */ }
    if (isAdmin()) {
      try {
        const result = await invokeUsers({ action: 'list' });
        const users = Array.isArray(result) ? result : (result.users || result.data || []);
        for (const u of users) historyNames[u.user_id || u.id] = u.full_name || u.name || u.email || historyNames[u.user_id || u.id];
      } catch (_e) { /* names are optional */ }
    }
  }
  renderHistory();
}
for (const id of ['historyFilter', 'historyFrom', 'historyTo']) $(id).addEventListener('input', renderHistory);
$('historyExport').addEventListener('click', () => {
  if (!isManager()) return;
  downloadCSV('hari-history.csv', [['Timestamp', 'Table', 'Action', 'User name'], ...cachedHistory.map(x => [x.created_at, x.table_name, x.action, historyNames[x.performed_by] || x.performed_by])]);
});

/* ---------- structure search (JSME editor + PubChem identity lookup) ---------- */
// JSME (free, BSD licence) is loaded on demand from the "jsme" folder next to inventory.html.
let editorState = 'idle'; // idle | loading | ready | missing
let jsmeApplet = null, jsmeWaiters = [];
const setEditorNotice = text => { const n = $('structureEditorNotice'); n.textContent = text || ''; show(n, Boolean(text)); };
const getEditor = () => (jsmeApplet && typeof jsmeApplet.smiles === 'function' ? jsmeApplet : null);
// JSME calls this global function once its files have loaded.
window.jsmeOnLoad = function () {
  try {
    jsmeApplet = new window.JSApplet.JSME('jsmeContainer', '100%', '480px');
    jsmeWaiters.splice(0).forEach(w => w.resolve(jsmeApplet));
  } catch (err) { jsmeWaiters.splice(0).forEach(w => w.reject(err)); }
};
function waitForEditor(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (getEditor()) return resolve(jsmeApplet);
    const waiter = { resolve, reject };
    jsmeWaiters.push(waiter);
    setTimeout(() => {
      const i = jsmeWaiters.indexOf(waiter);
      if (i >= 0) { jsmeWaiters.splice(i, 1); reject(Error('The structure editor did not finish loading.')); }
    }, timeoutMs);
  });
}
function loadEditorScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(Error('The structure editor files could not be loaded.'));
    document.head.appendChild(s);
  });
}
async function loadEditor() {
  if (editorState === 'loading' || editorState === 'ready') return;
  const box = $('jsmeContainer'), src = box.dataset.editorSrc;
  editorState = 'loading';
  setEditorNotice('');
  show(box, true);
  $('structureStatus').textContent = 'Loading the structure editor…';
  try {
    // Check the file exists first so a missing folder gives a clear message instead of a silent blank box.
    let missing = false;
    try { missing = (await fetch(src, { method: 'HEAD', cache: 'no-store' })).status === 404; }
    catch (_err) { missing = true; } // e.g. the page was opened from disk (file://) instead of a web server
    if (missing) {
      editorState = 'missing';
      show(box, false);
      setEditorNotice('The JSME structure editor was not found. Copy the JSME files into a "jsme" folder next to inventory.html and open the site through a web address (see JSME_SETUP.md). You can still search by pasting a SMILES string below.');
      $('structureStatus').textContent = '';
      return;
    }
    const ready = waitForEditor();
    if (!window.JSApplet) await loadEditorScript(src);
    else window.jsmeOnLoad();
    const api = await ready;
    editorState = 'ready';
    $('structureStatus').textContent = '';
    const pasted = $('structureSmiles').value.trim();
    if (pasted) { try { api.readGenericMolecularInput(pasted); } catch (_err) { /* shown when searching */ } }
  } catch (err) {
    editorState = 'idle'; // allow another attempt the next time the window is opened
    setEditorNotice(errorText(err) + ' Close and reopen this window to try again, or paste a SMILES string below.');
    $('structureStatus').textContent = '';
  }
}
$('structureSearchButton').addEventListener('click', () => {
  $('structureStatus').textContent = '';
  $('structureDialog').showModal();
  loadEditor();
});
$('closeStructure').addEventListener('click', () => $('structureDialog').close());
$('clearStructure').addEventListener('click', () => {
  $('structureStatus').textContent = '';
  $('structureSmiles').value = '';
  const api = getEditor();
  if (!api) return;
  try { api.reset(); }
  catch (err) { $('structureStatus').textContent = 'Unable to clear the editor: ' + errorText(err); }
});
// Pasting a SMILES string also draws it in the editor, so it can be checked and edited.
$('structureSmiles').addEventListener('change', () => {
  const api = getEditor(), text = $('structureSmiles').value.trim();
  if (!api || !text) return;
  try { api.readGenericMolecularInput(text); $('structureStatus').textContent = ''; }
  catch (err) { $('structureStatus').textContent = 'The editor could not read this SMILES: ' + errorText(err); }
});
async function chemoraRunStructureSearch(mode) {
  const message = $('structureStatus');
  try {
    // The drawing wins; the pasted SMILES is used when the editor is unavailable or empty.
    const api = getEditor();
    let smiles = '';
    if (api) {
      try { smiles = String(api.smiles() || '').trim(); }
      catch (err) { throw Error('The editor could not read the drawing: ' + errorText(err)); }
    }
    if (!smiles) smiles = $('structureSmiles').value.trim();
    if (!smiles) throw Error(api ? 'Draw a chemical structure or paste a SMILES string first.' : 'Paste a SMILES string; the drawing editor is not available.');
    if (/\s/.test(smiles) || smiles.length > 2000) throw Error('That does not look like a valid SMILES string.');
    if (mode !== 'exact') {
      message.textContent = `${mode === 'substructure' ? 'Substructure' : 'Similarity'} search needs an RDKit inventory search endpoint and stored chemical SMILES. No results were searched. Use Exact Match to find this compound by identity.`;
      return;
    }
    message.textContent = 'Identifying structure through PubChem…';
    const cidResponse = await fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/cids/JSON', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'smiles=' + encodeURIComponent(smiles) });
    if (!cidResponse.ok) throw Error('PubChem could not identify this structure.');
    const cid = (await cidResponse.json())?.IdentifierList?.CID?.find(n => n > 0);
    if (!cid) throw Error('PubChem could not identify this structure.');
    const synResponse = await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`);
    if (!synResponse.ok) throw Error('PubChem returned no names for this structure.');
    const synonyms = (await synResponse.json())?.InformationList?.Information?.[0]?.Synonym || [];
    const casList = [...new Set(synonyms.filter(s => validCAS(s)))].slice(0, 10);
    if (!casList.length && !synonyms.length) throw Error('PubChem returned no identifiers for this structure.');
    message.textContent = '';
    $('structureDialog').close();
    $('searchChemicalName').value = casList.length ? '' : synonyms[0];
    $('searchChemicalCas').value = casList[0] || '';
    $('searchChemicalBarcode').value = '';
    if (casList.length) { $('type').value = 'cas'; $('query').value = casList[0]; await loadChemicals('cas', casList); }
    else { $('type').value = 'name'; $('query').value = synonyms[0]; await loadChemicals('name', synonyms[0]); }
  } catch (err) { message.textContent = errorText(err); }
}
$('searchExact').addEventListener('click', () => chemoraRunStructureSearch('exact'));
$('searchSubstructure').addEventListener('click', () => chemoraRunStructureSearch('substructure'));
$('searchSimilarity').addEventListener('click', () => chemoraRunStructureSearch('similarity'));

/* ---------- inventory tools ---------- */
async function getContainerRows() {
  const [chems, conts, locs] = await Promise.all([
    fetchAll(() => db.from('inventory_chemicals').select('id,name,cas').order('id')),
    fetchAll(() => db.from('inventory_containers').select('*').order('id')),
    fetchAll(() => db.from('inventory_locations').select('id,name').order('id'))
  ]);
  const chemicals = new Map(chems.map(x => [x.id, x])), locNames = new Map(locs.map(x => [x.id, x.name]));
  return conts.map(x => {
    const loc = locations.find(l => l.id === x.location_id);
    return { ...x, chemical: chemicals.get(x.chemical_id), location_name: loc ? locationPath(loc) : (locNames.get(x.location_id) || '') };
  });
}
$('exportInventory').addEventListener('click', async () => {
  if (!isAdmin()) return;
  try {
    const rows = await getContainerRows();
    downloadCSV('hari-inventory.csv', [['Chemical', 'CAS', 'Barcode', 'Size', 'Remaining', 'Unit', 'Location', 'Supplier', 'Status'], ...rows.map(x => [x.chemical?.name, x.chemical?.cas, x.barcode, x.container_size, x.remaining_amount, x.unit, x.location_name, x.supplier, x.status])]);
    status('Exported ' + rows.length + ' containers.');
  } catch (e) { status(errorText(e)); }
});
$('recentContainers').addEventListener('click', async () => {
  if (!isAdmin()) return;
  try {
    const rows = (await getContainerRows()).filter(isActiveContainer);
    const key = x => String(x.created_at || x.received_at || '');
    rows.sort((a, b) => key(b).localeCompare(key(a)));
    $('toolsResult').innerHTML = '<table class="inventory-data-table"><thead><tr><th>Chemical</th><th>Barcode</th><th>Size</th><th>Location</th></tr></thead><tbody>' + rows.slice(0, 40).map(x => `<tr><td>${esc(x.chemical?.name)}</td><td>${esc(x.barcode)}</td><td>${esc(x.container_size)} ${esc(x.unit)}</td><td>${esc(x.location_name)}</td></tr>`).join('') + `</tbody></table><p class="muted">Newest 40 containers, ordered by ${rows[0]?.created_at ? 'creation time' : 'date received'}.</p>`;
  } catch (e) { status(errorText(e)); }
});
// Batch label sheet: a dedicated print area, because the global print rules hide everything else on the page.
function buildLabelSheet(rows) {
  let sheet = $('batchLabelSheet');
  if (!sheet) { sheet = document.createElement('div'); sheet.id = 'batchLabelSheet'; document.body.appendChild(sheet); }
  sheet.replaceChildren();
  for (const x of rows) {
    const label = document.createElement('div'); label.className = 'batch-label';
    const name = document.createElement('strong'); name.textContent = x.chemical?.name || 'Chemical';
    const cas = document.createElement('span'); cas.textContent = x.chemical?.cas ? 'CAS: ' + x.chemical.cas : '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const code = document.createElement('strong'); code.textContent = x.barcode;
    const meta = document.createElement('span'); meta.textContent = [`${x.container_size ?? ''} ${x.unit || ''}`.trim(), x.location_name].filter(Boolean).join(' · ');
    label.append(name, cas, svg, code, meta);
    sheet.appendChild(label);
    if (typeof window.JsBarcode === 'function') {
      try { window.JsBarcode(svg, x.barcode, { format: 'CODE128', displayValue: false, width: 1.5, height: 45, margin: 4, background: '#fff', lineColor: '#000' }); } catch (_e) { /* text fallback remains */ }
    }
  }
}
$('printLabels').addEventListener('click', async () => {
  if (!isAdmin()) return;
  try {
    const all = (await getContainerRows()).filter(x => x.barcode && isActiveContainer(x));
    const rows = all.slice(0, 100);
    $('toolsResult').innerHTML = `<p class="muted">${rows.length} Code 128 barcode label(s) ready${all.length > rows.length ? ` (first ${rows.length} of ${all.length}; print in batches)` : ''}. Scan a printed label before attaching it to a bottle.</p><div class="tool-grid">${rows.map(x => `<div class="card"><strong>${esc(x.chemical?.name)}</strong><p class="muted">${esc(x.barcode)}</p></div>`).join('')}</div><button type="button" class="btn secondary" id="printLabelsNow" style="margin-top:14px">Print labels</button>`;
    $('printLabelsNow').addEventListener('click', () => {
      buildLabelSheet(rows);
      const cleanup = () => document.body.classList.remove('print-batch');
      window.addEventListener('afterprint', cleanup, { once: true });
      document.body.classList.add('print-batch');
      window.print();
    });
  } catch (e) { status(errorText(e)); }
});
/* ---------- bulk CSV import ---------- */
const IMPORT_MAX_ROWS = 500;
const IMPORT_UNITS = { g: 'g', mg: 'mg', kg: 'kg', ml: 'mL', l: 'L' };
const IMPORT_COLUMNS = ['name', 'cas', 'formula', 'supplier', 'catalog_number', 'lot_number', 'purity', 'container_size', 'remaining_amount', 'unit', 'location', 'received_at', 'expires_at', 'notes'];
const IMPORT_REQUIRED = ['name', 'container_size', 'unit', 'location'];
const IMPORT_ALIASES = { chemical_name: 'name', chemical: 'name', container_name: 'name', cas_number: 'cas', cas_no: 'cas', substance_cas: 'cas', molecular_formula: 'formula', size: 'container_size', remaining: 'remaining_amount', remaining_quantity: 'remaining_amount', catalog: 'catalog_number', catalog_no: 'catalog_number', lot: 'lot_number', lot_no: 'lot_number', storage_location: 'location', location_path: 'location', date_received: 'received_at', received: 'received_at', date_acquired: 'received_at', expiry: 'expires_at', expiry_date: 'expires_at', expires: 'expires_at', comments: 'notes', note: 'notes' };

/* @@import-pure-start */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = first.split(';').length > first.split(',').length ? ';' : ','; // Excel in some locales saves with semicolons
  const rows = []; let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += ch;
  }
  if (inQuotes) throw Error('The file has an unterminated quoted value.');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
function parseImportDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else if ((match = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) { d = +match[1]; m = +match[2]; y = +match[3]; }
  else return { error: `Invalid date "${s}" (use YYYY-MM-DD or DD/MM/YYYY)` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { error: `Invalid date "${s}"` };
  return { value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}
// "Lab > Cabinet 1 > Shelf 2" and "Lab / Cabinet 1 / Shelf 2" are the same path.
const splitLocationPath = text => String(text ?? '').split(/[\/>]/).map(s => s.trim()).filter(Boolean);
function buildLocationIndex() {
  const norm = s => splitLocationPath(s).join(' / ').toLowerCase();
  const byPath = new Map(), byName = new Map();
  for (const l of locations) {
    byPath.set(norm(locationPath(l)), l);
    const n = norm(l.name);
    byName.set(n, [...(byName.get(n) || []), l]);
  }
  return { byPath, byName, norm };
}
function resolveImportLocation(text, index, createMissing = false) {
  const segments = splitLocationPath(text);
  if (!segments.length) return { error: 'Location is required' };
  const key = index.norm(text);
  let l = index.byPath.get(key);
  if (!l) {
    const list = index.byName.get(key) || [];
    if (list.length > 1) return { error: `Location "${text}" is ambiguous; use the full path` };
    l = list[0];
  }
  if (l) {
    if (l.active === false) return { error: `Location "${locationPath(l)}" is inactive` };
    return { id: l.id, path: locationPath(l) };
  }
  if (!createMissing) return { error: `Unknown location "${text}" (tick "Create missing locations" to create it)` };
  if (segments.length > locationLevels.length) return { error: `Location "${text}" is nested more than ${locationLevels.length} levels deep` };
  for (let i = 1; i < segments.length; i++) {
    const parent = index.byPath.get(index.norm(segments.slice(0, i).join(' / ')));
    if (parent && parent.active === false) return { error: `Location "${locationPath(parent)}" is inactive` };
  }
  return { id: 'plan:' + key, path: segments.join(' / '), plan: segments, planKey: key };
}
function validateImportRow(r, index, createMissing = false) {
  const errors = [];
  const get = k => String(r[k] ?? '').trim();
  const name = get('name');
  if (!name) errors.push('Chemical name is required'); else if (name.length > 300) errors.push('Name is too long');
  const cas = get('cas');
  if (cas && !validCAS(cas)) errors.push(`Invalid CAS "${cas}"`);
  const size = Number(get('container_size'));
  if (get('container_size') === '' || !Number.isFinite(size) || size <= 0) errors.push('Container size must be a positive number');
  const unit = IMPORT_UNITS[get('unit').toLowerCase()];
  if (!unit) errors.push(`Unit "${get('unit')}" must be one of g, mg, kg, mL, L`);
  let remaining = null;
  if (get('remaining_amount') !== '') {
    const n = Number(get('remaining_amount'));
    if (!Number.isFinite(n) || n < 0) errors.push('Remaining amount must be zero or more');
    else if (size > 0 && n > size) errors.push('Remaining amount exceeds container size');
    else remaining = n;
  }
  const loc = get('location') ? resolveImportLocation(get('location'), index, createMissing) : { error: 'Location is required' };
  if (loc.error) errors.push(loc.error);
  const rec = parseImportDate(get('received_at')); if (rec.error) errors.push(rec.error);
  const exp = parseImportDate(get('expires_at')); if (exp.error) errors.push(exp.error);
  if (rec.value && exp.value && exp.value < rec.value) errors.push('Expiry precedes receipt date');
  const payload = errors.length ? null : { name, cas: optional(cas), formula: optional(get('formula')), supplier: optional(get('supplier')), catalog_number: optional(get('catalog_number')), lot_number: optional(get('lot_number')), purity: optional(get('purity')), container_size: size, remaining_amount: remaining, unit, location_id: loc.id, owner_id: null, received_at: rec.value, expires_at: exp.value, notes: optional(get('notes')), chemical_notes: '' };
  return { errors, payload, plan: loc.plan || null, planKey: loc.planKey || null, label: { name, cas, size: `${get('container_size')} ${unit || get('unit')}`.trim(), location: (loc.path || get('location')) + (loc.plan ? ' (new)' : '') } };
}
const importDupeKey = p => [String(p.cas || p.name || '').toLowerCase(), p.location_id, Number(p.container_size), p.unit, String(p.lot_number || '').toLowerCase()].join('|');
// Every location path (and each parent level) that a set of rows needs but the database does not have yet.
function plannedLocationKeys(rows) {
  const index = buildLocationIndex(), keys = new Map();
  for (const r of rows) {
    if (!r.plan) continue;
    for (let i = 1; i <= r.plan.length; i++) {
      const k = index.norm(r.plan.slice(0, i).join(' / '));
      if (!index.byPath.has(k) && !keys.has(k)) keys.set(k, r.plan.slice(0, i));
    }
  }
  return keys;
}
/* @@import-pure-end */

const importMsg = text => status(text, 'importStatus');
// Creates missing locations one level at a time (parents first), then returns the id for each planned path.
async function createPlannedLocations(rows) {
  const keys = plannedLocationKeys(rows);
  const byDepth = new Map();
  for (const segs of keys.values()) byDepth.set(segs.length, [...(byDepth.get(segs.length) || []), segs]);
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const index = buildLocationIndex();
    const batch = byDepth.get(depth).map(segs => {
      let parentId = null;
      if (depth > 1) {
        const parent = index.byPath.get(index.norm(segs.slice(0, -1).join(' / ')));
        if (!parent) throw Error(`The parent of "${segs.join(' / ')}" was not created.`);
        parentId = parent.id;
      }
      return { name: segs[segs.length - 1], description: null, location_type: locationLevels[depth - 1], parent_id: parentId };
    });
    const { error } = await db.from('inventory_locations').insert(batch);
    if (error) throw Error('Could not create locations: ' + error.message);
    await loadLocations();
  }
  const index = buildLocationIndex(), ids = new Map();
  for (const r of rows) {
    if (!r.plan) continue;
    const loc = index.byPath.get(index.norm(r.plan.join(' / ')));
    if (!loc) throw Error(`Location "${r.plan.join(' / ')}" was not found after it was created.`);
    ids.set(r.planKey, loc.id);
  }
  return { ids, created: keys.size };
}
function buildImportRows() {
  if (!importSource) return;
  const { headers, dataRows, existing } = importSource;
  const index = buildLocationIndex(), seen = new Map(), createMissing = $('importCreateLocations').checked;
  importRows = dataRows.map((cells, i) => {
    const obj = {};
    headers.forEach((h, c) => { if (h && !(h in obj)) obj[h] = cells[c] ?? ''; });
    const row = { line: i + 2, ...validateImportRow(obj, index, createMissing), dupe: null, result: null, failure: null };
    if (row.payload) {
      const key = importDupeKey(row.payload);
      if (existing.has(key)) row.dupe = 'Already in inventory';
      else if (seen.has(key)) row.dupe = `Same as row ${seen.get(key)} in this file`;
      else seen.set(key, row.line);
    }
    return row;
  });
}
async function handleImportFile(file) {
  importRows = []; importSource = null;
  $('importRun').classList.add('hide'); $('importDownload').classList.add('hide');
  $('importPreview').replaceChildren();
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return importMsg('The file is larger than 2 MB. Split it into smaller files.');
  let table;
  try { table = parseCSV(await file.text()); } catch (err) { return importMsg(errorText(err)); }
  if (table.length < 2) return importMsg('The file has no data rows.');
  const headers = table[0].map(h => { const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_'); return IMPORT_ALIASES[k] || k; });
  const missing = IMPORT_REQUIRED.filter(k => !headers.includes(k));
  if (missing.length) return importMsg('Missing required column(s): ' + missing.join(', ') + '. Download the template to see the expected columns.');
  const dataRows = table.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS) return importMsg(`This file has ${dataRows.length} rows; the limit is ${IMPORT_MAX_ROWS} per import. Split it into smaller files.`);
  importMsg('Checking rows…');
  const existing = new Set();
  let duplicateCheck = true;
  try {
    for (const x of await getContainerRows()) {
      if (isActiveContainer(x) && x.chemical) existing.add(importDupeKey({ cas: x.chemical.cas, name: x.chemical.name, location_id: x.location_id, container_size: x.container_size, unit: x.unit, lot_number: x.lot_number }));
    }
  } catch (_err) { duplicateCheck = false; }
  importSource = { headers, dataRows, existing };
  buildImportRows();
  renderImportPreview();
  if (!duplicateCheck) importMsg('Could not compare with existing inventory, so duplicates already in the database were not detected. ' + $('importStatus').textContent);
}
const importQueue = () => importRows.filter(r => r.payload && !r.result && !($('importSkipDupes').checked && r.dupe));
function renderImportPreview() {
  if (!importRows.length) return;
  const skip = $('importSkipDupes').checked;
  const errors = importRows.filter(r => !r.payload).length;
  const skipped = importRows.filter(r => r.payload && r.dupe && skip && !r.result).length;
  const imported = importRows.filter(r => r.result).length;
  const queue = importQueue(), queued = queue.length;
  const newLocations = plannedLocationKeys(queue).size;
  const cell = r => {
    if (r.result) return `<span class="order-badge received">Imported</span> ${esc(r.result)}`;
    if (r.failure) return `<span class="import-error">${esc(r.failure)}</span>`;
    if (!r.payload) return `<span class="import-error">${esc(r.errors.join('; '))}</span>`;
    if (r.dupe) return `<span class="order-badge ordered">Possible duplicate</span> ${esc(r.dupe)}${skip ? ' — will be skipped' : ' — will be imported'}`;
    return '<span class="order-badge received">Ready</span>';
  };
  $('importPreview').innerHTML = '<table class="inventory-data-table"><thead><tr><th>Row</th><th>Chemical</th><th>CAS</th><th>Size</th><th>Location</th><th>Status</th></tr></thead><tbody>' +
    importRows.slice(0, 200).map(r => `<tr><td>${r.line}</td><td>${esc(r.label.name)}</td><td>${esc(r.label.cas || '—')}</td><td>${esc(r.label.size)}</td><td>${esc(r.label.location)}</td><td>${cell(r)}</td></tr>`).join('') +
    `</tbody></table>${importRows.length > 200 ? `<p class="muted">Showing the first 200 of ${importRows.length} rows. All rows are processed.</p>` : ''}`;
  importMsg(`${importRows.length} row(s): ${queued} ready to import, ${errors} with errors (never imported), ${skipped} skipped as possible duplicates${imported ? `, ${imported} already imported` : ''}.${newLocations ? ` ${newLocations} new location(s) will be created.` : ''}`);
  $('importRun').textContent = `Import ${queued} container(s)`;
  show($('importRun'), queued > 0 && !importBusy);
  show($('importDownload'), importRows.some(r => r.result || r.failure));
}
async function runImport() {
  if (importBusy || !isAdmin()) return;
  const todo = importQueue();
  if (!todo.length) return;
  const planned = todo.filter(r => r.plan);
  const newLocations = plannedLocationKeys(planned).size;
  if (!confirm(`Import ${todo.length} container(s)?${newLocations ? `\n\nThis will first create ${newLocations} new location(s).` : ''}\n\nRows are saved one at a time. A failed row does not undo the rows already saved.`)) return;
  importBusy = true;
  $('importRun').classList.add('hide'); $('importFile').disabled = true; $('importCreateLocations').disabled = true;
  let done = 0, failed = 0, streak = 0, aborted = false;
  try {
    if (planned.length) {
      importMsg('Creating locations…');
      const { ids } = await createPlannedLocations(planned);
      for (const r of planned) { r.payload.location_id = ids.get(r.planKey); r.plan = null; r.planKey = null; r.label.location = r.label.location.replace(/ \(new\)$/, ''); }
    }
    for (const r of todo) {
      r.failure = null;
      try {
        const { data, error } = await db.rpc('inventory_register_container_phase3', { p: r.payload });
        if (error) throw error;
        r.result = data?.barcode || '(no barcode returned)'; done++; streak = 0;
      } catch (err) { r.failure = errorText(err); failed++; streak++; }
      importMsg(`Importing ${done + failed}/${todo.length}…`);
      if (streak >= 5) { aborted = true; break; } // e.g. a permission problem: stop instead of failing every row
    }
  } catch (err) {
    importBusy = false; $('importFile').disabled = false; $('importCreateLocations').disabled = false;
    renderImportPreview();
    importMsg(errorText(err));
    showToast(errorText(err), 'error');
    return;
  }
  importBusy = false; $('importFile').disabled = false; $('importCreateLocations').disabled = false;
  renderImportPreview();
  const summary = `Import finished: ${done} saved, ${failed} failed${aborted ? '. Stopped after 5 failures in a row; fix the cause and run the import again to continue with the remaining rows' : ''}.`;
  importMsg(summary);
  showToast(summary, failed ? 'error' : 'success');
  if (done && !$('chemoraResultsPanel').classList.contains('hide')) clearResults(); // cached search results are now stale
}
$('importHelp').addEventListener('click', () => {
  if (!isAdmin()) return;
  $('toolsResult').replaceChildren();
  show($('importPanel'), true);
  importMsg('');
});
document.querySelector('#view-tools .tool-grid').addEventListener('click', e => { if (!e.target.closest('#importHelp')) show($('importPanel'), false); });
$('importFile').addEventListener('change', async e => { const file = e.target.files[0]; await handleImportFile(file); e.target.value = ''; });
$('importSkipDupes').addEventListener('change', renderImportPreview);
$('importCreateLocations').addEventListener('change', () => {
  if (!importBusy && !importRows.some(r => r.result)) buildImportRows(); // re-check the rows with the new option
  renderImportPreview();
});
$('importRun').addEventListener('click', runImport);
$('importTemplate').addEventListener('click', () => {
  const sample = activeLocations()[0] ? locationPath(activeLocations()[0]) : 'Main Building / Room 101 / Cabinet A';
  downloadCSV('chemora-import-template.csv', [IMPORT_COLUMNS,
    ['Ethanol', '64-17-5', 'C2H6O', 'Merck', 'E-1234', 'LOT001', '99.9%', '2.5', '2.5', 'L', sample, '2026-01-15', '2028-01-15', 'Example row: replace or delete'],
    ['Acetone', '67-64-1', 'C3H6O', '', '', '', '', '500', '', 'mL', sample, '15/02/2026', '', '']]);
});
$('importDownload').addEventListener('click', () => {
  downloadCSV('chemora-import-results.csv', [['Row', 'Chemical', 'CAS', 'Location', 'Result', 'Barcode or error'],
    ...importRows.filter(r => r.result || r.failure).map(r => [r.line, r.label.name, r.label.cas, r.label.location, r.result ? 'Imported' : 'Failed', r.result || r.failure])]);
});

/* ---------- user management ---------- */
async function invokeUsers(payload) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw Error('Session expired. Sign in again.');
  const r = await fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/functions/v1/inventory-users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token, 'apikey': cfg.supabaseAnonKey }, body: JSON.stringify(payload) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw Error(body.error || `Request failed (${r.status})`);
  return body;
}
function renderUsers() {
  const filter = ($('userFilter')?.value || '').trim().toLowerCase();
  const roleFilter = $('userRoleFilter')?.value || '';
  const users = cachedUsers.filter(u => (!roleFilter || u.role === roleFilter) && (!filter || [u.full_name, u.name, u.email].some(v => String(v || '').toLowerCase().includes(filter))));
  const container = $('userList');
  if (!users.length) { container.textContent = 'No matching users.'; return; }
  const roleName = r => r === 'admin' ? 'Administrator' : r === 'manager' ? 'Chemical Manager' : 'Member';
  container.innerHTML = `<table class="inventory-data-table chemora-user-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${users.map(u => {
    const id = u.user_id || u.id, locked = u.account_status === 'locked';
    return `<tr><td><strong>${esc(u.full_name || u.name || 'User')}</strong></td><td>${esc(u.email || '—')}</td><td>${esc(roleName(u.role))}</td><td><span class="order-badge ${locked ? 'ordered' : 'received'}">${locked ? 'Locked' : 'Active'}</span></td><td><button class="btn secondary" type="button" data-user-edit="${esc(id)}">Edit</button></td></tr><tr class="user-edit-row hide" data-user-row="${esc(id)}"><td colspan="5"><form class="user-edit-form"><div class="row"><label class="field">Full name<input name="name" value="${esc(u.full_name || u.name || '')}" required></label><label class="field">Email<input name="email" type="email" value="${esc(u.email || '')}" required></label></div><div class="row"><label class="field">Role<select name="role">${['member', 'manager', 'admin'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleName(r)}</option>`).join('')}</select></label><label class="field">New password (optional, 12+ characters)<input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="Leave blank to keep password"></label></div><div class="actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-user-close>Cancel</button>${id !== user.id ? `<button class="btn secondary" type="button" data-user-lock>${locked ? 'Unlock' : 'Lock'}</button><button class="btn danger" type="button" data-user-delete>Deactivate account</button>` : ''}</div><p class="status user-edit-status" role="status"></p></form></td></tr>`;
  }).join('')}</tbody></table>`;
  container.querySelectorAll('[data-user-edit]').forEach(b => b.addEventListener('click', () => container.querySelector(`[data-user-row="${b.dataset.userEdit}"]`)?.classList.toggle('hide')));
  container.querySelectorAll('[data-user-row]').forEach(row => {
    const id = row.dataset.userRow, u = users.find(x => (x.user_id || x.id) === id), f = row.querySelector('form');
    const note = text => { f.querySelector('.user-edit-status').textContent = text; };
    row.querySelector('[data-user-close]').addEventListener('click', () => row.classList.add('hide'));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const password = val(f, 'password');
      const payload = { action: 'update', userId: id, name: val(f, 'name'), email: val(f, 'email'), role: val(f, 'role') };
      if (password) { if (password.length < 12) return note('Password must contain at least 12 characters.'); payload.password = password; }
      if (id === user.id && payload.role !== 'admin') return note('You cannot remove your own administrator access.');
      try { await invokeUsers(payload); await loadUsers(); status('Account updated.'); } catch (err) { note(errorText(err)); }
    });
    row.querySelector('[data-user-lock]')?.addEventListener('click', async () => {
      try { await invokeUsers({ action: u.account_status === 'locked' ? 'unlock' : 'lock', userId: id }); await loadUsers(); status('Account status updated.'); } catch (err) { note(errorText(err)); }
    });
    row.querySelector('[data-user-delete]')?.addEventListener('click', async () => {
      if (!confirm('Deactivate this account? Its historical records will be retained.')) return;
      try { await invokeUsers({ action: 'delete', userId: id }); await loadUsers(); status('User deactivated.'); } catch (err) { note(errorText(err)); }
    });
  });
}
async function loadUsers() {
  $('userList').textContent = 'Loading users…';
  try {
    const result = await invokeUsers({ action: 'list' });
    cachedUsers = Array.isArray(result) ? result : Array.isArray(result.users) ? result.users : Array.isArray(result.data) ? result.data : [];
    renderUsers();
  } catch (err) { $('userList').textContent = errorText(err); }
}
$('userFilter')?.addEventListener('input', renderUsers);
$('userRoleFilter')?.addEventListener('change', renderUsers);
$('refreshUsers')?.addEventListener('click', loadUsers);
$('userForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await invokeUsers({ action: 'create', name: val(f, 'name'), email: val(f, 'email'), password: val(f, 'password'), role: val(f, 'role') });
    f.reset();
    status('User created.');
    loadUsers();
    loadContainerOwners();
  } catch (err) { status(errorText(err)); } finally { submit.disabled = false; }
});

initSession().catch(e => { showLoggedOut(); status(errorText(e), 'loginError'); });
})();
