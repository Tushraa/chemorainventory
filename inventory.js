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
document.documentElement.classList.add('ci-root');

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
let scanDestination = null, collectionRows = [];
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
  for (const id of ['chemicalCards', 'orderList', 'historyList', 'userList', 'toolsResult', 'locationList', 'collectionList', 'scanLog']) $(id)?.replaceChildren();
  scanDestination = null; collectionRows = [];
  $('chemoraResultsCount').textContent = '';
  show($('chemoraResultsPanel'), false);
  $('chemoraToastContainer')?.replaceChildren();
  labContext = null;
  show($('labSwitcher'), false); show($('labSwitchLabel'), false); show($('createLabPanel'), false);
}
function showLoggedOut() {
  closeAccountDrawer(); setMenuOpen(false); document.body.classList.remove('ci-platform-only'); show($('auth'), true); show($('portal'), false); show($('profileCard'), false); show($('topActions'), false);
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
  document.querySelectorAll('.platform-only').forEach(el => show(el, Boolean(labContext?.platform_admin)));
  // The Inventory Administrator only works in Labs & All Users.
  document.body.classList.toggle('ci-platform-only', Boolean(labContext?.platform_admin));
  document.querySelectorAll('.platform-home').forEach(el => show(el, Boolean(labContext?.platform_admin)));
  document.querySelectorAll('#mobileModule option').forEach(o => {
    const allowed = (!o.hasAttribute('data-manager') || isManager()) && (!o.hasAttribute('data-admin') || isAdmin()) && (!o.hasAttribute('data-platform') || Boolean(labContext?.platform_admin));
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
    if (result.data?.lab_deactivated) { await rejectSession('Your laboratory has been deactivated by the Inventory Administrator, so you cannot sign in. Please contact the Inventory Administrator.'); return; }
    if ((!result.data?.lab_id && !result.data?.platform_admin) || !result.data?.role) { await rejectSession('Your account is not approved for inventory access.'); return; }
    role = result.data.role;
    labContext = result.data;
    const { data: profile } = await db.from('inventory_user_profiles').select('full_name,account_status').eq('user_id', user.id).maybeSingle();
    if (profile?.account_status === 'locked') { await rejectSession('This account is locked. Contact the administrator.'); return; }
    displayName = profile?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';
  }
  if (!user) { resetState(); showLoggedOut(); return; }

  show($('auth'), false); show($('portal'), true); show($('profileCard'), true); show($('topActions'), true);
  $('who').textContent = displayName;
  $('profileRole').textContent = labContext?.platform_admin ? 'Inventory Administrator' : (role === 'admin' ? 'Administrator' : role === 'manager' ? 'Chemical Manager' : 'Member') + (labContext?.lab_name ? ' · ' + labContext.lab_name : '');
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'HG';
  $('profileAvatar').textContent = initials; $('drawerAvatar').textContent = initials; $('drawerEmail').textContent = user.email || '';
  $('accountButton').title = displayName;
  applyRoleVisibility();
  renderLabControls();
  setTab('chemicals');
  $('chemicalCards').replaceChildren();
  show($('chemoraResultsPanel'), false);
  $('chemoraResultsCount').textContent = '';
  status('', 'searchStatus');
  if (!labContext?.platform_admin) await Promise.all([loadLocations(), loadContainerOwners()]); // the Inventory Administrator only works in Labs & All Users
}
/* Lab switcher and lab creation (data of different labs never mixes: the database only returns the selected lab). */
function renderLabControls() {
  const labs = labContext?.labs || [], sw = $('labSwitcher');
  sw.replaceChildren(...labs.map(l => new Option(l.name, l.id)));
  sw.value = labContext?.lab_id || '';
  show(sw, labs.length > 1); show($('labSwitchLabel'), labs.length > 1);
  show($('createLabPanel'), Boolean(labContext?.platform_admin));
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
$('addLabButton')?.addEventListener('click', () => $('addLabDialog').showModal());
$('labForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget, name = val(f, 'name'), prefix = val(f, 'prefix').toUpperCase(), adminEmail = val(f, 'admin_email').toLowerCase();
  if (!name) return status('Lab name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return status('Enter the lab administrator\'s e-mail. Every lab needs an administrator.');
  if (!/^[A-Z0-9]{1,8}$/.test(prefix)) return status('Barcode prefix must be 1-8 letters or numbers.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug.length < 2) return status('Use a lab name with at least two letters or numbers.');
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await db.rpc('inventory_create_lab', { p_name: name, p_slug: slug, p_prefix: prefix, p_admin_email: adminEmail });
    if (error) return status(/duplicate key|already exists/i.test(error.message) ? 'A lab with that name already exists.' : error.message);
    f.reset(); f.elements.prefix.value = 'LAB'; $('addLabDialog').close();
    const ctx = await db.rpc('inventory_my_context'); if (!ctx.error && ctx.data) { labContext = ctx.data; renderLabControls(); }
    await loadPlatform();
    status('Lab "' + name + '" created; ' + adminEmail + ' is its administrator.');
  } finally { submit.disabled = false; }
});
const TAB_GROUPS = { orders: ['orders', 'requests'], admin: ['users', 'history', 'tools', 'platform'] };
function setGroup(group, open) {
  document.querySelectorAll(`[data-group-body="${group}"]`).forEach(el => show(el, open));
  document.querySelectorAll(`.side-group-toggle[data-group="${group}"]`).forEach(b => { b.setAttribute('aria-expanded', String(open)); b.classList.toggle('open', open); });
}
function setTab(name) {
  if (labContext?.platform_admin) name = 'platform';
  if (!$('view-' + name)) name = 'chemicals';
  if ((['history', 'scan'].includes(name) && !isManager()) || (['users', 'tools'].includes(name) && !isAdmin()) || (name === 'platform' && !labContext?.platform_admin)) return;
  document.querySelectorAll('.tab-view').forEach(el => show(el, el.id === 'view-' + name));
  $('portal').dataset.activeTab = name;
  if ($('mobileModule')) $('mobileModule').value = name === 'tools' ? 'users' : name;
  // 'tools' is the page behind the Inventory Management menus, so it highlights Inventory Management.
  const menuName = name === 'tools' ? 'users' : name;
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === menuName));
  for (const [group, tabs] of Object.entries(TAB_GROUPS)) if (tabs.includes(name)) setGroup(group, true);
  if (name === 'requests') loadOrders();
  if (name === 'locations') { show($('locationContents'), false); locEditMode = false; $('locationEditToggle').textContent = 'Edit'; show($('locationForm'), false); loadLocations(); }
  if (name === 'history') loadHistory();
  if (name === 'users') loadUsers();
  if (name === 'platform') loadPlatform();
  if (name === 'add') { loadContainerOwners(); renderLocationUi(); }
  if (name === 'collection') loadCollection();
  if (name === 'scan') initScan();
}
/* Phone menu (like ChemInventory's "Show Menu"): the Menu button drops the module list down; picking a page closes it. */
function setMenuOpen(open) {
  document.body.classList.toggle('ci-menu-open', open);
  const t = $('menuToggle'); if (!t) return;
  t.setAttribute('aria-expanded', String(open));
  t.querySelector('span').textContent = open ? 'Close' : 'Menu';
  t.querySelector('i').className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
}
$('menuToggle')?.addEventListener('click', () => setMenuOpen(!document.body.classList.contains('ci-menu-open')));
$('tabs')?.addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setMenuOpen(false); });
document.querySelectorAll('.side-group-toggle').forEach(b => b.addEventListener('click', () => setGroup(b.dataset.group, b.getAttribute('aria-expanded') !== 'true')));
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
  closeAccountDrawer();
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
document.querySelectorAll('#tabs button[data-tab], .top-action[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('[data-open-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.openTab)));

/* ---------- locations ---------- */
const LOCATION_TYPES = ['cabinet', 'shelf', 'fridge', 'tray'];
const PARENT_TYPES = ['cabinet', 'shelf', 'fridge']; // a Tray cannot contain other locations
const MAX_LOCATION_DEPTH = 5;
function locationPath(l, seen = new Set()) {
  if (seen.has(l.id)) return l.name;
  seen.add(l.id);
  const parent = locations.find(x => x.id === l.parent_id);
  return parent ? locationPath(parent, seen) + ' / ' + l.name : l.name;
}
const activeLocations = () => [...locations].filter(l => l.active !== false).sort((a, b) => locationPath(a).localeCompare(locationPath(b)));
function refreshLocationParent() {
  if (!$('locationParent')) return;
  const prev = $('locationParent').value;
  const options = activeLocations().filter(l => PARENT_TYPES.includes(l.location_type));
  $('locationParent').replaceChildren(new Option('No parent (top level)', ''), ...options.map(l => new Option(locationPath(l), l.id)));
  $('locationParent').value = options.some(l => l.id === prev) ? prev : '';
  $('locationParent').required = false;
  $('locationParent').disabled = false;
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
  renderLocationUi();
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
  if (!LOCATION_TYPES.includes(type)) return status('Choose Cabinet, Shelf, Fridge or Tray.');
  if (parent && !PARENT_TYPES.includes(locations.find(l => l.id === parent)?.location_type)) return status('Only a Cabinet, Shelf or Fridge can contain other locations.');
  if (locations.some(l => (l.parent_id || null) === (parent || null) && l.name.toLowerCase() === name.toLowerCase())) return status('A location with this name already exists under the same parent.');
  const { error } = await db.from('inventory_locations').insert({ name, description: optional(val(f, 'description')), location_type: type, parent_id: parent || null });
  status(error ? error.message : 'Location added.');
  if (!error) { f.reset(); await loadLocations(); }
});

/* ---------- search ---------- */
const structureUrl = c => 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' + encodeURIComponent(c.cas || c.name) + '/PNG?image_size=240x240';
function clearResults() {
  searchSeq++; selectedKeys = new Set(); currentRows = [];
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
  activeList = 'search'; selectedKeys = new Set(); show($('locationContents'), false);
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
    <div class="chemora-ghs-summary"><h3>GHS Safety Summary${isManager() ? ' <button type="button" class="chemora-detail-edit" data-ghs-edit>Edit</button>' : ''}</h3>${ghsSummaryHtml(c)}<a href="${esc('https://pubchem.ncbi.nlm.nih.gov/#query=' + encodeURIComponent(c.cas || c.name))}" target="_blank" rel="noopener noreferrer">View PubChem safety information</a></div>
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
    <div class="chemora-detail-links">${isManager() && selected ? `<button class="btn secondary" type="button" data-duplicate="${esc(selected.id)}">Duplicate Container</button>` : ''}${isManager() && selected ? `<button class="btn secondary" type="button" data-history="${esc(selected.id)}">View History</button>` : ''}${selected?.barcode ? `<button class="btn secondary" type="button" data-print-container="${esc(selected.id)}">Print Barcode Label</button>` : ''}${isManager() && selected ? `<button class="btn secondary" type="button" data-lifecycle="${esc(selected.id)}">Manage Container</button>` : ''}${isManager() ? '<button class="btn danger" type="button" data-delete-chemical-inline>Delete Chemical</button>' : ''}</div>
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
  const dupBtn = e.target.closest('[data-duplicate]');
  if (dupBtn) { const x = lastContainers.find(z => z.id === dupBtn.dataset.duplicate), c = x && lastChemicals.find(z => z.id === x.chemical_id); if (c) { $('chemicalDialog').close(); prefillDuplicate(c, x); } return; }
  const histBtn = e.target.closest('[data-history]');
  if (histBtn) return showContainerHistory(histBtn.dataset.history);
  if (e.target.closest('[data-ghs-edit]')) {
    const c = lastChemicals.find(z => z.id === activeChemicalId);
    if (c && isManager()) openGhsEditor(ghsList(c), async codes => {
      const { error } = await updateRow('inventory_chemicals', c.id, { ghs_codes: codes });
      if (error) return showToast(/ghs_codes/.test(error.message) ? 'Run sql/05_platform_admin.sql in Supabase to enable hazard codes.' : error.message, 'error');
      c.ghs_codes = codes; showToast('Hazard codes saved.', 'success'); openChemical(c.id, activeContainerId);
    });
    return;
  }
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
function openContainerAction(id, preset) {
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
  if (preset) $('containerActionType').value = preset;
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
  const fields = ['name', 'cas', 'formula', 'supplier', 'catalog_number', 'lot_number', 'purity', 'unit', 'location_id', 'owner_id', 'received_at', 'expires_at', 'notes', 'barcode'];
  const payload = Object.fromEntries(fields.map(k => [k, optional(val(f, k))]));
  payload.name = name;
  payload.container_size = size;
  payload.remaining_amount = rawAmount === '' ? null : Number(rawAmount);
  payload.chemical_notes = '';
  try { payload.ghs_codes = JSON.parse(val(f, 'ghs_codes') || '[]'); } catch (_e) { payload.ghs_codes = []; }
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  msg('Registering container…');
  try {
    const { data, error } = await db.rpc('inventory_register_container_phase3', { p: payload });
    if (error) throw error;
    f.reset(); resetAddForm();
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
  downloadCSV('chemora-pending-orders.csv', [['Chemical', 'CAS', 'Size', 'Unit', 'Supplier', 'Status', 'Requested at', 'Requested by', 'Comments'],
    ...cachedOrders.filter(o => o.status === 'requested' || o.status === 'ordered').map(o => [o.chemical_name, o.cas, o.container_size, o.unit, o.supplier, o.status, o.requested_at, o.requester_name || o.requested_by, o.comments])]);
});
$('exportOrders').addEventListener('click', async () => {
  if (!isManager()) return;
  try {
    // The list shows open orders only; the full export includes received and cancelled ones as well.
    const all = await fetchAll(() => db.from('inventory_orders').select('*').order('requested_at', { ascending: false }).order('id'));
    await attachRequesterNames(all);
    downloadCSV('chemora-orders.csv', [['Chemical', 'CAS', 'Size', 'Unit', 'Supplier', 'Status', 'Requested at', 'Ordered at', 'Received at', 'Requested by', 'Comments'],
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
const SUBJECT_LABELS = { inventory_containers: 'Container', inventory_chemicals: 'Substance', inventory_locations: 'Location', inventory_orders: 'Order' };
const EVENT_LABELS = { insert: 'Creation', update: 'Edit', delete: 'Deletion' };
const historySubject = x => SUBJECT_LABELS[x.table_name] || x.table_name;
const historyEvent = x => EVENT_LABELS[x.action] || x.action;
const historyUser = x => historyNames[x.performed_by] || (x.performed_by ? 'Former user' : 'System');
const historyText = x => x.description || `${historySubject(x)} ${String(x.action || '').toLowerCase()} (record ${String(x.record_id || '').slice(0, 8)})`;
const historyStamp = x => String(x.created_at || '').replace('T', ' ').slice(0, 19);
function filteredHistory() {
  const q = $('historyFilter').value.trim().toLowerCase(), from = $('historyFrom').value, to = $('historyTo').value;
  const who = $('historyUser').value, subject = $('historySubject').value;
  return cachedHistory.filter(x => {
    const day = String(x.created_at || '').slice(0, 10);
    return (!from || day >= from) && (!to || day <= to) && (!who || x.performed_by === who) && (!subject || x.table_name === subject)
      && (!q || [historyEvent(x), historyText(x)].some(v => String(v).toLowerCase().includes(q)));
  });
}
function renderHistory() {
  const items = filteredHistory();
  $('historyList').innerHTML = '<table class="inventory-data-table"><thead><tr><th>Timestamp (UTC)</th><th>User</th><th>Subject</th><th>Event</th><th>Description</th></tr></thead><tbody>' +
    (items.length ? items.map(x => `<tr><td>${esc(historyStamp(x))}</td><td>${esc(historyUser(x))}</td><td>${esc(historySubject(x))}</td><td>${esc(historyEvent(x))}</td><td>${esc(historyText(x))}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">No activity matches these filters.</td></tr>') + '</tbody></table>';
}
function fillHistoryUsers() {
  const keep = $('historyUser').value;
  const people = [...new Set(cachedHistory.map(x => x.performed_by).filter(Boolean))].map(id => [id, historyNames[id] || 'Former user']).sort((a, b) => a[1].localeCompare(b[1]));
  $('historyUser').replaceChildren(new Option('All users', ''), ...people.map(([id, name]) => new Option(name, id)));
  $('historyUser').value = people.some(([id]) => id === keep) ? keep : '';
}
function isoDay(d) { return d.toISOString().slice(0, 10); }
async function loadHistory() {
  if (!isManager()) return;
  if (!$('historyFrom').value && !$('historyTo').value) { $('historyFrom').value = isoDay(new Date(Date.now() - 30 * 864e5)); $('historyTo').value = isoDay(new Date()); }
  let { data, error } = await db.from('inventory_activity_logs').select('created_at,table_name,record_id,action,performed_by,description').order('created_at', { ascending: false }).limit(2000);
  if (error && /description/i.test(error.message)) {
    // Database not upgraded with sql/04_activity_descriptions.sql yet: fall back to generated descriptions.
    ({ data, error } = await db.from('inventory_activity_logs').select('created_at,table_name,record_id,action,performed_by').order('created_at', { ascending: false }).limit(2000));
  }
  if (error) { status(error.message); return; }
  cachedHistory = data || [];
  const ids = [...new Set(cachedHistory.map(x => x.performed_by).filter(Boolean))];
  historyNames = {};
  if (ids.length) {
    try {
      const { data: named } = await db.rpc('inventory_history_names', { p_ids: ids });
      for (const p of named || []) historyNames[p.user_id] = p.name;
    } catch (_e) { /* run sql/09 to show names of people outside the lab */ }
    try {
      const profiles = await fetchIn('inventory_user_profiles', 'user_id', ids, { select: 'user_id,full_name,email', order: 'user_id' });
      for (const p of profiles) historyNames[p.user_id] = p.full_name || p.email || historyNames[p.user_id];
    } catch (_e) { /* names are optional */ }
    if (isAdmin()) {
      try {
        const result = await invokeUsers({ action: 'list' });
        const users = Array.isArray(result) ? result : (result.users || result.data || []);
        for (const u of users) historyNames[u.user_id || u.id] = u.full_name || u.name || u.email || historyNames[u.user_id || u.id];
      } catch (_e) { /* names are optional */ }
    }
  }
  fillHistoryUsers();
  renderHistory();
}
for (const id of ['historyFilter', 'historyFrom', 'historyTo', 'historyUser', 'historySubject']) $(id).addEventListener('input', renderHistory);
$('historyExport').addEventListener('click', () => {
  if (!isManager()) return;
  downloadCSV('chemora-history.csv', [['Timestamp (UTC)', 'User', 'Subject', 'Event', 'Description'], ...filteredHistory().map(x => [historyStamp(x), historyUser(x), historySubject(x), historyEvent(x), historyText(x)])]);
});

/* ---------- my collection ---------- */
async function loadCollection() {
  status('Loading your containers…', 'collectionStatus');
  try {
    const rows = (await getContainerRows()).filter(x => isActiveContainer(x) && x.owner_id === user.id);
    collectionRows = rows;
    status(rows.length ? '' : 'You do not own any containers yet.', 'collectionStatus');
    renderCollection();
  } catch (e) { status(errorText(e), 'collectionStatus'); }
}
function renderCollection() {
  const q = $('collectionFilter').value.trim().toLowerCase();
  const rows = collectionRows.filter(x => !q || [x.chemical?.name, x.chemical?.cas, x.barcode, x.location_name].some(v => String(v || '').toLowerCase().includes(q)));
  $('collectionList').innerHTML = rows.length ? '<table class="inventory-data-table"><thead><tr><th>Name</th><th>CAS</th><th>Barcode</th><th>Remaining</th><th>Location</th></tr></thead><tbody>' +
    rows.map(x => `<tr><td>${esc(x.chemical?.name)}</td><td>${esc(x.chemical?.cas || '—')}</td><td>${esc(x.barcode)}</td><td>${esc(x.remaining_amount ?? x.container_size)} / ${esc(x.container_size)} ${esc(x.unit)}</td><td>${esc(x.location_name)}</td></tr>`).join('') + '</tbody></table>' : '';
}
$('collectionFilter').addEventListener('input', renderCollection);
$('collectionExport').addEventListener('click', () => {
  downloadCSV('my-collection.csv', [['Name', 'CAS', 'Barcode', 'Size', 'Remaining', 'Unit', 'Location'], ...collectionRows.map(x => [x.chemical?.name, x.chemical?.cas, x.barcode, x.container_size, x.remaining_amount, x.unit, x.location_name])]);
});

/* ---------- scan to move ---------- */
function setScanDestination(loc) {
  scanDestination = loc || null;
  $('scanDestination').textContent = loc ? 'Destination: ' + locationPath(loc) + (loc.barcode ? ' (' + loc.barcode + ')' : '') : 'No destination selected.';
  $('scanContainerCode').disabled = !loc;
  if (loc) $('scanContainerCode').focus();
}
function initScan() {
  const sorted = [...locations].filter(l => l.active !== false).sort((a, b) => locationPath(a).localeCompare(locationPath(b)));
  $('scanLocationSelect').replaceChildren(new Option('Select location', ''), ...sorted.map(l => new Option(locationPath(l), l.id)));
  if (scanDestination) $('scanLocationSelect').value = scanDestination.id;
  setScanDestination(scanDestination);
  status('', 'scanStatus');
}
$('scanLocationSelect').addEventListener('change', e => setScanDestination(locations.find(l => l.id === e.target.value)));
$('scanLocationCode').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim().toUpperCase();
  if (!code) return;
  const loc = locations.find(l => String(l.barcode || '').toUpperCase() === code && l.active !== false);
  if (!loc) { setScanDestination(null); status('No active location has barcode ' + code + '.', 'scanStatus'); return; }
  $('scanLocationSelect').value = loc.id; e.target.value = '';
  status('', 'scanStatus'); setScanDestination(loc);
});
function logScan(code, outcome, ok) {
  const row = document.createElement('tr');
  for (const text of [new Date().toLocaleTimeString(), code, outcome]) { const td = document.createElement('td'); td.textContent = text; row.appendChild(td); }
  row.className = ok ? 'scan-ok' : 'scan-fail';
  let table = $('scanLog').querySelector('table');
  if (!table) { $('scanLog').innerHTML = '<table class="inventory-data-table"><thead><tr><th>Time</th><th>Barcode</th><th>Result</th></tr></thead><tbody></tbody></table>'; table = $('scanLog').querySelector('table'); }
  table.tBodies[0].prepend(row);
}
$('scanContainerCode').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (!isManager() || !scanDestination) return;
  const input = e.target, code = input.value.trim().toUpperCase();
  if (!code) return;
  input.disabled = true;
  try {
    const { data, error } = await db.from('inventory_containers').select('id,location_id,status').eq('barcode', code).maybeSingle();
    if (error) { logScan(code, error.message, false); return; }
    if (!data) { logScan(code, 'No container with this barcode.', false); return; }
    if (data.status === 'disposed') { logScan(code, 'Container is disposed and cannot be moved.', false); return; }
    if (data.location_id === scanDestination.id) { logScan(code, 'Already at ' + scanDestination.name + '.', false); return; }
    const res = await db.rpc('inventory_container_action_phase3', { p_id: data.id, p_action: 'move', p: { location_id: scanDestination.id } });
    logScan(code, res.error ? res.error.message : 'Moved to ' + locationPath(scanDestination), !res.error);
  } finally { input.value = ''; input.disabled = !scanDestination; input.focus(); }
});

/* ---------- inventory management menus ---------- */
document.querySelectorAll('.im-toolbar-slot').forEach(slot => slot.appendChild($('imToolbarTpl').content.cloneNode(true)));
function closeImMenus(except) {
  document.querySelectorAll('.im-menu').forEach(m => {
    if (m === except) return;
    show(m.querySelector('.im-list'), false); m.querySelector('.im-toggle').setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', e => {
  const toggle = e.target.closest('.im-toggle');
  if (toggle) {
    const menu = toggle.closest('.im-menu'), list = menu.querySelector('.im-list'), opening = list.classList.contains('hide');
    closeImMenus(menu); show(list, opening); toggle.setAttribute('aria-expanded', String(opening));
    return;
  }
  closeImMenus();
  const item = e.target.closest('[data-im]');
  if (item && isAdmin()) runImAction(item.dataset.im);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeImMenus(); });
async function runImAction(action) {
  if (action === 'users') return setTab('users');
  if (action === 'columns') return openColumns();
  setTab('tools');
  $('toolsResult').replaceChildren(); show($('importPanel'), false); show($('bulkUpdatePanel'), false); show($('stocktakePanel'), false);
  if (action === 'import') $('importHelp').click();
  else if (action === 'export') $('exportInventory').click();
  else if (action === 'labels') $('printLabels').click();
  else if (action === 'recent') $('recentContainers').click();
  else if (action === 'deleted') await showDeletedContainers();
  else if (action === 'settings') await showLabSettings();
  else if (action === 'bulk') { resetBulk(); show($('bulkUpdatePanel'), true); }
  else if (action === 'stocktake') { resetStock(); show($('stocktakePanel'), true); }
  else if (action === 'assigned') await showAssignedBarcodes();
}
async function showDeletedContainers() {
  try {
    const rows = (await getContainerRows()).filter(x => !isActiveContainer(x));
    rows.sort((a, b) => String(b.disposed_at || b.updated_at || '').localeCompare(String(a.disposed_at || a.updated_at || '')));
    $('toolsResult').innerHTML = rows.length ? '<h3>Deleted Containers</h3><table class="inventory-data-table"><thead><tr><th>Chemical</th><th>Barcode</th><th>Size</th><th>Last location</th><th>Disposed</th></tr></thead><tbody>' +
      rows.map(x => `<tr><td>${esc(x.chemical?.name)}</td><td>${esc(x.barcode)}</td><td>${esc(x.container_size)} ${esc(x.unit)}</td><td>${esc(x.location_name)}</td><td>${esc(String(x.disposed_at || x.updated_at || '').slice(0, 10))}</td></tr>`).join('') + '</tbody></table><p class="muted">Disposed containers are archived here with their history until the chemical record is deleted.</p>' : '<p class="muted">No deleted containers.</p>';
  } catch (e) { status(errorText(e)); }
}
async function showLabSettings() {
  try {
    const rows = await getContainerRows();
    const active = rows.filter(isActiveContainer).length;
    const roleName = role === 'admin' ? 'Administrator' : role === 'manager' ? 'Chemical Manager' : 'Member';
    const items = [['Lab', labContext?.lab_name || '—'], ['Your role', roleName + (labContext?.platform_admin ? ' (platform administrator)' : '')], ['Active containers', active], ['Archived containers', rows.length - active], ['Locations', locations.length], ['Labs you belong to', (labContext?.labs || []).length || 1]];
    $('toolsResult').innerHTML = '<h3>License &amp; Settings</h3><table class="inventory-data-table"><tbody>' + items.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</tbody></table>';
  } catch (e) { status(errorText(e)); }
}

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
      setEditorNotice('The JSME structure editor was not found. Copy the JSME files into a "jsme" folder next to inventory.html and open the site through a web address (see JSME_SETUP.md).');
      $('structureStatus').textContent = '';
      return;
    }
    const ready = waitForEditor();
    if (!window.JSApplet) await loadEditorScript(src);
    else window.jsmeOnLoad();
    const api = await ready;
    editorState = 'ready';
    $('structureStatus').textContent = '';
  } catch (err) {
    editorState = 'idle'; // allow another attempt the next time the window is opened
    setEditorNotice(errorText(err) + ' Close and reopen this window to try again.');
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
  const api = getEditor();
  if (!api) return;
  try { api.reset(); }
  catch (err) { $('structureStatus').textContent = 'Unable to clear the editor: ' + errorText(err); }
});
async function chemoraRunStructureSearch(mode) {
  const message = $('structureStatus');
  try {
    const api = getEditor();
    let smiles = '';
    if (api) {
      try { smiles = String(api.smiles() || '').trim(); }
      catch (err) { throw Error('The editor could not read the drawing: ' + errorText(err)); }
    }
    if (!smiles) throw Error(api ? 'Draw a chemical structure first.' : 'The drawing editor is not available.');
    if (/\s/.test(smiles) || smiles.length > 2000) throw Error('That does not look like a valid SMILES string.');
    if (mode !== 'exact') { await runStructureMatch(mode, smiles, message); return; }
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

/* ---------- substructure and similarity search (RDKit in the browser) ---------- */
const RDKIT_BASE = 'https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2025.3.4-1.0.0/dist/';
let rdkitPromise = null;
function loadRdkit() {
  if (window.__chemoraRdkit) return Promise.resolve(window.__chemoraRdkit);
  if (!rdkitPromise) rdkitPromise = new Promise((resolve, reject) => {
    const fail = () => { rdkitPromise = null; reject(Error('Could not load the chemistry engine (RDKit). Check your internet connection and try again.')); };
    const start = () => window.initRDKitModule({ locateFile: f => RDKIT_BASE + f }).then(m => { window.__chemoraRdkit = m; resolve(m); }, fail);
    if (typeof window.initRDKitModule === 'function') return start();
    const tag = document.createElement('script');
    tag.src = RDKIT_BASE + 'RDKit_minimal.js'; tag.onload = start; tag.onerror = fail;
    document.head.appendChild(tag);
  });
  return rdkitPromise;
}
const SMILES_CACHE_KEY = 'chemora-smiles';
function readSmilesCache() { try { return JSON.parse(localStorage.getItem(SMILES_CACHE_KEY) || '{}') || {}; } catch (_e) { return {}; } }
function writeSmilesCache(map) { try { localStorage.setItem(SMILES_CACHE_KEY, JSON.stringify(map)); } catch (_e) { /* private mode */ } }
const smilesKey = c => (labContext?.lab_id || '') + '|' + (c.cas && validCAS(c.cas) ? c.cas : String(c.name || '').toLowerCase());
const wait = ms => new Promise(r => setTimeout(r, ms));
// Returns a SMILES string, '' when PubChem does not know the chemical, or null when the lookup failed (try again later).
async function pubchemSmiles(c) {
  const key = c.cas && validCAS(c.cas) ? c.cas : String(c.name || '').trim();
  if (!key) return '';
  for (const prop of ['SMILES', 'IsomericSMILES']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(key)}/property/${prop}/JSON`); }
      catch (_e) { await wait(1200); continue; }
      if (r.status === 404) return '';
      if (r.status === 429 || r.status === 503) { await wait(1500); continue; }
      if (!r.ok) break;
      const p = (await r.json())?.PropertyTable?.Properties?.[0] || {};
      return String(p.SMILES || p.IsomericSMILES || p.ConnectivitySMILES || p.CanonicalSMILES || '').trim();
    }
  }
  return null;
}
async function resolveStructures(chemicals, progress) {
  const cache = readSmilesCache(), todo = chemicals.filter(c => c.smiles == null && cache[smilesKey(c)] == null);
  const found = [], failed = [];
  for (let i = 0; i < todo.length; i++) {
    progress(i, todo.length);
    const smiles = await pubchemSmiles(todo[i]);
    if (smiles === null) failed.push(todo[i]); else { cache[smilesKey(todo[i])] = smiles; found.push({ id: todo[i].id, smiles }); }
    if (i % 10 === 9) writeSmilesCache(cache);
    await wait(230); // PubChem allows about 5 requests per second
  }
  writeSmilesCache(cache);
  if (found.length && isManager()) {
    // Save to the database for everyone (needs sql/06). Falls back silently to this browser's cache.
    for (let i = 0; i < found.length; i += 500) { try { await db.rpc('inventory_save_smiles', { p_items: found.slice(i, i + 500) }); } catch (_e) { break; } }
  }
  return { looked: todo.length, failed: failed.length };
}
function bitsTanimoto(a, b) {
  let both = 0, either = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] === '1', y = b[i] === '1'; if (x && y) both++; if (x || y) either++; }
  return either ? both / either : 0;
}
async function runStructureMatch(mode, smiles, message) {
  const buttons = ['searchExact', 'searchSubstructure', 'searchSimilarity'].map($);
  buttons.forEach(b => { b.disabled = true; });
  try {
    message.textContent = 'Loading the chemistry engine…';
    const RDKit = await loadRdkit();
    const query = RDKit.get_mol(smiles);
    if (!query || !query.is_valid()) { query?.delete(); throw Error('That structure could not be read. Check the drawing or SMILES.'); }
    const snap = await fetchSnapshot();
    const inUse = new Set(snap.containers.map(x => x.chemical_id));
    const chems = snap.chemicals.filter(c => inUse.has(c.id));
    const stats = await resolveStructures(chems, (i, n) => { message.textContent = `Looking up structures from PubChem (first search only): ${i + 1} of ${n}…`; });
    message.textContent = 'Searching…';
    const cache = readSmilesCache();
    const threshold = Math.min(1, Math.max(0, (Number($('similarityThreshold')?.value) || 50) / 100));
    const queryFp = mode === 'similarity' ? query.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })) : null;
    const hits = new Map();
    let searched = 0;
    for (const c of chems) {
      const target = c.smiles != null ? c.smiles : cache[smilesKey(c)];
      if (!target) continue;
      let mol = null;
      try {
        mol = RDKit.get_mol(target);
        if (!mol || !mol.is_valid()) continue;
        searched++;
        if (mode === 'substructure') {
          const m = mol.get_substruct_match(query);
          if (m && m !== '{}' && JSON.parse(m).atoms?.length) hits.set(c.id, 1);
        } else {
          const t = bitsTanimoto(queryFp, mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })));
          if (t >= threshold) hits.set(c.id, t);
        }
      } catch (_e) { /* skip structures RDKit cannot read */ } finally { mol?.delete(); }
    }
    query.delete();
    message.textContent = '';
    $('structureDialog').close();
    $('searchChemicalName').value = ''; $('searchChemicalCas').value = ''; $('searchChemicalBarcode').value = '';
    await runSnapshotSearch(({ c }) => hits.has(c.id), snap);
    const noStructure = chems.length - searched;
    status(`${mode === 'substructure' ? 'Substructure' : 'Similarity (at least ' + Math.round(threshold * 100) + '%)'} search: ${hits.size} matching chemical(s) among ${searched} with a known structure.` +
      (noStructure ? ` ${noStructure} chemical(s) have no structure on record (PubChem did not recognise them) and were not searched.` : '') +
      (stats.failed ? ` ${stats.failed} lookup(s) failed; search again later to retry.` : ''), 'searchStatus');
  } catch (err) { message.textContent = errorText(err); }
  finally { buttons.forEach(b => { b.disabled = false; }); }
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
    downloadCSV('chemora-inventory.csv', [['Chemical', 'CAS', 'Barcode', 'Size', 'Remaining', 'Unit', 'Location', 'Supplier', 'Status'], ...rows.map(x => [x.chemical?.name, x.chemical?.cas, x.barcode, x.container_size, x.remaining_amount, x.unit, x.location_name, x.supplier, x.status])]);
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
const IMPORT_UNITS = { g: 'g', mg: 'mg', kg: 'kg', ml: 'mL', l: 'L', mmol: 'mmol', mol: 'mol', units: 'units', rxns: 'rxns', 'cu ft': 'cu ft' };
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
  if (segments.length > MAX_LOCATION_DEPTH) return { error: `Location "${text}" is nested more than ${MAX_LOCATION_DEPTH} levels deep` };
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
// Type of a location the CSV importer has to create: taken from the name (Cabinet / Shelf / Fridge / Tray),
// otherwise Cabinet for a top-level entry and Shelf below it. A Tray can never contain another location.
function guessLocationType(segs, allPlanned) {
  const name = segs[segs.length - 1].toLowerCase();
  const prefix = segs.map(s => s.toLowerCase()).join('\u0000') + '\u0000';
  const isParent = allPlanned.some(o => o.length > segs.length && o.map(s => s.toLowerCase()).join('\u0000').startsWith(prefix));
  const hit = LOCATION_TYPES.find(t => new RegExp('\\b' + t + '\\b').test(name));
  if (hit && !(hit === 'tray' && isParent)) return hit;
  return segs.length === 1 ? 'cabinet' : 'shelf';
}
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
      return { name: segs[segs.length - 1], description: null, location_type: guessLocationType(segs, [...keys.values()]), parent_id: parentId };
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
  if (!users.length) { container.innerHTML = '<p class="muted" style="padding:10px">No matching users.</p>'; return; }
  const roleName = r => r === 'admin' ? 'Administrator' : r === 'manager' ? 'Chemical Manager' : 'Member';
  container.innerHTML = `<table class="inventory-data-table chemora-user-table"><thead><tr><th>Name</th><th>Email</th><th>Account Type</th><th>Actions</th></tr></thead><tbody>${users.map(u => {
    const id = u.user_id || u.id, locked = u.account_status === 'locked';
    return `<tr${locked ? ' class="is-locked"' : ''}><td><strong>${esc(u.full_name || u.name || 'User')}</strong>${u.platform_admin ? ' <span class="order-badge received">Inventory Administrator</span>' : ''}${locked ? ' <span class="order-badge ordered">Locked</span>' : ''}</td><td>${esc(u.email || '—')}</td><td>${esc(roleName(u.role))}</td><td><span class="row-actions">${id !== user.id && !u.platform_admin ? `<button type="button" class="icon-btn" data-user-lock="${esc(id)}" title="${locked ? 'Unlock account' : 'Lock account'}" aria-label="${locked ? 'Unlock account' : 'Lock account'}"><i class="fa-solid ${locked ? 'fa-lock-open' : 'fa-lock'}"></i></button>` : ''}${u.platform_admin ? '' : `<button type="button" class="icon-btn" data-user-edit="${esc(id)}" title="Edit user" aria-label="Edit user"><i class="fa-solid fa-pen-to-square"></i></button>`}${id !== user.id ? `<button type="button" class="icon-btn" data-user-delete="${esc(id)}" title="Remove from this lab" aria-label="Remove from this lab"><i class="fa-solid fa-trash"></i></button>` : ''}</span></td></tr><tr class="user-edit-row hide" data-user-row="${esc(id)}"><td colspan="4"><form class="user-edit-form"><div class="row"><label class="field">Full name<input name="name" value="${esc(u.full_name || u.name || '')}" required></label><label class="field">Email<input name="email" type="email" value="${esc(u.email || '')}" required></label></div><div class="row"><label class="field">Account type<select name="role">${['member', 'manager', 'admin'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleName(r)}</option>`).join('')}</select></label><label class="field">New password (optional, 12+ characters)<input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="Leave blank to keep password"></label></div><div class="actions"><button class="btn green" type="submit">Save changes</button><button class="btn" type="button" data-user-close>Cancel</button></div><p class="status user-edit-status" role="status"></p></form></td></tr>`;
  }).join('')}</tbody></table>`;
  container.querySelectorAll('[data-user-edit]').forEach(b => b.addEventListener('click', () => container.querySelector(`[data-user-row="${b.dataset.userEdit}"]`)?.classList.toggle('hide')));
  container.querySelectorAll('[data-user-lock]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => (x.user_id || x.id) === b.dataset.userLock);
    try { await invokeUsers({ action: u.account_status === 'locked' ? 'unlock' : 'lock', userId: b.dataset.userLock }); await loadUsers(); status('Account status updated.'); } catch (err) { status(errorText(err)); }
  }));
  container.querySelectorAll('[data-user-delete]').forEach(b => b.addEventListener('click', async () => {
    const target = users.find(x => (x.user_id || x.id) === b.dataset.userDelete);
    if (!confirm(target?.platform_admin ? 'Remove the Inventory Administrator from this lab? Their platform-wide access is not affected.' : 'Delete this account from this lab? If they belong to no other lab the account is deactivated and can no longer sign in. Containers and history are kept.')) return;
    try { await invokeUsers({ action: 'delete', userId: b.dataset.userDelete }); await loadUsers(); status('Account deleted from this lab.'); } catch (err) { status(errorText(err)); }
  }));
  container.querySelectorAll('[data-user-row]').forEach(row => {
    const id = row.dataset.userRow, f = row.querySelector('form');
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
$('addUserButton')?.addEventListener('click', () => $('addUserDialog').showModal());
$('userForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const submit = f.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await invokeUsers({ action: 'create', name: val(f, 'name'), email: val(f, 'email'), password: val(f, 'password'), role: val(f, 'role') });
    f.reset(); $('addUserDialog').close();
    status('User added.');
    loadUsers();
    loadContainerOwners();
  } catch (err) { status(errorText(err)); } finally { submit.disabled = false; }
});

/* =====================================================================
   Chemora interface layer: location tree, result lists, advanced / GHS search,
   add-container steps, location contents. (Functions above stay unchanged.)
   ===================================================================== */

/* ---------- generic dialog helpers ---------- */
document.querySelectorAll('[data-close-dialog]').forEach(b => b.addEventListener('click', () => b.closest('dialog')?.close()));
document.addEventListener('click', e => { if (e.target instanceof HTMLDialogElement && e.target.open) e.target.close(); });
const ownerName = id => ownerProfiles.find(p => p.user_id === id)?.full_name || '';

/* ---------- location tree ---------- */
let locEditMode = false, locSelectedId = null, pickCallback = null;
const byLocName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
const childLocs = (parentId, includeInactive) => locations.filter(l => (l.parent_id || null) === (parentId || null) && (includeInactive || l.active !== false)).sort(byLocName);
function descendantIds(id) { const out = [id]; for (const c of locations.filter(l => l.parent_id === id)) out.push(...descendantIds(c.id)); return out; }
function buildLocationTree(ul, { mode = 'browse', selectedId = '', onPick = null, includeInactive = false, edit = false } = {}) {
  ul.replaceChildren();
  const open = new Set();
  for (let l = locations.find(x => x.id === selectedId); l; l = locations.find(x => x.id === l.parent_id)) open.add(l.parent_id);
  const make = (loc) => {
    const li = document.createElement('li'); li.dataset.locId = loc.id; li.setAttribute('role', 'treeitem');
    const kids = childLocs(loc.id, includeInactive);
    const row = document.createElement('div'); row.className = 'loc-node' + (selectedId === loc.id ? ' selected' : '');
    const caret = document.createElement('span'); caret.className = 'caret';
    caret.innerHTML = kids.length ? '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>' : '<i class="fa-regular fa-folder" aria-hidden="true"></i>';
    const name = document.createElement('span'); name.className = 'loc-name'; name.textContent = loc.name + (loc.active === false ? ' (inactive)' : '');
    row.append(caret, name);
    if (mode === 'browse' && loc.parent_id && loc.barcode) { const code = document.createElement('span'); code.className = 'loc-code'; code.textContent = '(' + loc.barcode + ')'; row.append(code); }
    if (mode === 'browse') {
      const all = document.createElement('button'); all.type = 'button'; all.className = 'view-all'; all.dataset.viewAll = loc.id; all.textContent = '[ view all ]'; row.append(all);
      if (edit) {
        const ed = document.createElement('button'); ed.type = 'button'; ed.className = 'icon-btn small'; ed.dataset.editLocation = loc.id; ed.title = 'Rename'; ed.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>';
        const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'icon-btn small' + (loc.active === false ? '' : ' danger'); tg.dataset.toggleLocation = loc.id; tg.title = loc.active === false ? 'Activate' : 'Deactivate';
        tg.innerHTML = loc.active === false ? '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>' : '<i class="fa-solid fa-ban" aria-hidden="true"></i>';
        row.append(ed, tg);
      }
    }
    li.appendChild(row);
    let sub = null;
    if (kids.length) {
      sub = document.createElement('ul'); sub.className = open.has(loc.id) ? '' : 'hide';
      if (open.has(loc.id)) caret.firstChild.className = 'fa-solid fa-chevron-down';
      kids.forEach(k => sub.appendChild(make(k)));
      li.appendChild(sub);
    }
    row.addEventListener('click', ev => {
      if (ev.target.closest('[data-view-all],[data-edit-location],[data-toggle-location]')) return;
      if (sub) { const hidden = sub.classList.toggle('hide'); caret.firstChild.className = hidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down'; }
      ul.querySelectorAll('.loc-node.selected').forEach(n => n.classList.remove('selected'));
      row.classList.add('selected');
      if (mode === 'browse') locSelectedId = loc.id;
      if (onPick) onPick(loc.id, loc);
    });
    return li;
  };
  childLocs(null, includeInactive).forEach(l => ul.appendChild(make(l)));
  if (!ul.children.length) { const li = document.createElement('li'); li.className = 'muted'; li.style.padding = '8px'; li.textContent = 'No locations yet.'; ul.appendChild(li); }
}
function renderLocationUi() {
  buildLocationTree($('locationList'), { mode: 'browse', selectedId: locSelectedId || '', edit: locEditMode && isAdmin(), includeInactive: isAdmin() });
  buildLocationTree($('addLocationPicker'), { mode: 'pick', selectedId: $('chemicalLocation').value, onPick: id => { $('chemicalLocation').value = id; } });
  syncLimitLink();
}
function syncLimitLink() {
  const l = locations.find(x => x.id === $('searchLocation').value);
  $('limitLocationLink').textContent = l ? locationPath(l) : 'All locations';
}
function openLocationPicker(title, cb, { allowClear = false, selectedId = '' } = {}) {
  pickCallback = cb;
  $('locationPickerDialog').querySelector('h2').textContent = title;
  show($('clearLocationLimit'), allowClear);
  buildLocationTree($('searchLocationPicker'), { mode: 'pick', includeInactive: false, selectedId, onPick: (id, loc) => {
    if (loc.active === false) return;
    $('locationPickerDialog').close(); const f = pickCallback; pickCallback = null; if (f) f(id);
  } });
  $('locationPickerDialog').showModal();
}
const chooseLocation = (title, opts) => new Promise(resolve => {
  let done = false;
  openLocationPicker(title, id => { done = true; resolve(id); }, opts);
  $('locationPickerDialog').addEventListener('close', () => { if (!done) resolve(null); }, { once: true });
});
$('limitLocationLink').addEventListener('click', async () => {
  const id = await chooseLocation('Limit search to a location', { allowClear: true, selectedId: $('searchLocation').value });
  if (id === null) return;
  $('searchLocation').value = id; syncLimitLink();
  $('searchLocation').dispatchEvent(new Event('change'));
});
$('clearLocationLimit').addEventListener('click', () => { $('locationPickerDialog').close(); pickCallback = null; $('searchLocation').value = ''; syncLimitLink(); $('searchLocation').dispatchEvent(new Event('change')); });
$('locationEditToggle').addEventListener('click', () => { locEditMode = !locEditMode; $('locationEditToggle').textContent = locEditMode ? 'Done' : 'Edit'; show($('locationForm'), locEditMode && isAdmin()); renderLocationUi(); });
$('locationList').addEventListener('click', e => {
  const b = e.target.closest('[data-view-all]');
  if (b) showLocationContainers(b.dataset.viewAll);
});

/* ---------- result lists (search and location pages) ---------- */
const COLUMN_DEFS = { cas: 'CAS Number', barcode: 'Barcode', size: 'Size', remaining: 'Remaining', location: 'Location', supplier: 'Supplier', acquired: 'Date Acquired', owner: 'Owner' };
let tableColumns = [];
try { tableColumns = JSON.parse(localStorage.getItem('chemora-columns') || '[]').filter(k => COLUMN_DEFS[k]); } catch (_e) { tableColumns = []; }
let activeList = 'search', viewMode = { search: 'table', location: 'table' }, selectedKeys = new Set(), currentRows = [];
const rowKey = r => r.x ? r.x.id : 'c:' + r.c.id;
function cellText(key, r) {
  const { c, x } = r;
  const loc = x && locations.find(l => l.id === x.location_id);
  switch (key) {
    case 'cas': return c.cas || '';
    case 'barcode': return x?.barcode || '';
    case 'size': return x ? `${x.container_size} ${x.unit || ''}`.trim() : '';
    case 'remaining': return x ? `${x.remaining_amount ?? x.container_size} ${x.unit || ''}`.trim() : '';
    case 'location': return loc ? locationPath(loc) : '';
    case 'supplier': return x?.supplier || '';
    case 'acquired': return x?.received_at || '';
    case 'owner': return x ? ownerName(x.owner_id) : '';
    default: return '';
  }
}
function computeRows() {
  const limit = activeList === 'search' ? $('searchLocation').value : '';
  return lastChemicals.flatMap(c => {
    const rows = lastContainers.filter(x => x.chemical_id === c.id && (!limit || x.location_id === limit) && (!matchedContainerIds || matchedContainerIds.has(x.id)));
    if (rows.length) return rows.map(x => ({ c, x }));
    return (limit || matchedContainerIds) ? [] : [{ c, x: null }];
  });
}
const iconBtn = (act, icon, title, extra = '') => `<button type="button" class="icon-btn ${extra}" data-act="${act}" title="${title}" aria-label="${title}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
function renderRowsInto(target, rows, mode) {
  const manager = isManager();
  if (!rows.length) { target.innerHTML = '<p class="muted" style="padding:10px">No matching containers.</p>'; return; }
  if (mode === 'grid') {
    target.innerHTML = '<div class="result-grid">' + rows.map(r => `<button type="button" class="grid-tile" data-act="info" data-key="${esc(rowKey(r))}"><span class="tile-img"><img src="${esc(structureUrl(r.c))}" alt="Structure of ${esc(r.c.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'fa-solid fa-flask-vial',style:'font-size:46px;color:#9aa3a7'}))"></span><span class="tile-name"><b>Name:</b> ${esc(r.c.name)}</span></button>`).join('') + '</div>';
    return;
  }
  const cols = tableColumns;
  target.innerHTML = '<table class="inventory-data-table ci-results"><thead><tr>' + (manager ? '<th class="check-col"><input type="checkbox" data-check-all aria-label="Select all"></th>' : '') + '<th><i>Container Name</i></th>' + cols.map(k => `<th>${COLUMN_DEFS[k]}</th>`).join('') + '<th>Actions</th></tr></thead><tbody>' +
    rows.map(r => `<tr data-key="${esc(rowKey(r))}">${manager ? `<td class="check-col">${r.x ? `<input type="checkbox" data-check ${selectedKeys.has(rowKey(r)) ? 'checked' : ''} aria-label="Select ${esc(r.c.name)}">` : ''}</td>` : ''}<td><button type="button" class="name-link" data-act="info">${esc(r.c.name)}</button></td>${cols.map(k => `<td>${esc(cellText(k, r))}</td>`).join('')}<td><span class="row-actions">${iconBtn('info', 'fa-circle-info', 'Container details')}${manager && r.x ? iconBtn('move', 'fa-house', 'Move container') : ''}${iconBtn('order', 'fa-cart-shopping', 'Request an order')}${manager && r.x ? iconBtn('delete', 'fa-trash', 'Delete container', 'danger') : ''}</span></td></tr>`).join('') + '</tbody></table>';
}
function renderList() {
  const rows = computeRows(); currentRows = rows;
  const search = activeList === 'search';
  const target = search ? $('chemicalCards') : $('locationContainers');
  renderRowsInto(target, rows, viewMode[activeList]);
  const n = rows.filter(r => r.x).length || rows.length;
  if (search) {
    $('chemoraResultsCount').textContent = `${n} Result${n === 1 ? '' : 's'} Found`;
    $('resultsSummary').textContent = `The following ${n} container(s) were found:`;
    $('resultsLabName').textContent = labContext?.lab_name || 'Results';
    show($('bulkBar'), isManager() && selectedKeys.size > 0);
  } else {
    $('locationSummary').textContent = `The following ${n} container(s) were found:`;
  }
  return n;
}
const renderChemicalCards = renderList;
function setView(list, mode) {
  viewMode[list] = mode;
  const [t, g] = list === 'search' ? ['viewTable', 'viewGrid'] : ['locViewTable', 'locViewGrid'];
  $(t).classList.toggle('active', mode === 'table'); $(g).classList.toggle('active', mode === 'grid');
  if (activeList === list) renderList();
}
$('viewTable').addEventListener('click', () => setView('search', 'table'));
$('viewGrid').addEventListener('click', () => setView('search', 'grid'));
$('locViewTable').addEventListener('click', () => setView('location', 'table'));
$('locViewGrid').addEventListener('click', () => setView('location', 'grid'));
function downloadRows(name) {
  const rows = computeRows();
  downloadCSV(name, [['Container Name', 'CAS', 'Barcode', 'Size', 'Remaining', 'Unit', 'Location', 'Supplier', 'Date Acquired', 'Status', 'GHS codes'],
    ...rows.map(r => [r.c.name, r.c.cas, r.x?.barcode, r.x?.container_size, r.x?.remaining_amount, r.x?.unit, cellText('location', r), r.x?.supplier, r.x?.received_at, r.x?.status, (r.c.ghs_codes || []).join(' ')])]);
}
$('downloadResults').addEventListener('click', () => { activeList = 'search'; downloadRows('chemora-search-results.csv'); });
$('locDownload').addEventListener('click', () => { activeList = 'location'; downloadRows('chemora-location-containers.csv'); });
function updateBulkBar() { if (activeList === 'search') show($('bulkBar'), isManager() && selectedKeys.size > 0); else { show($('locMoveAll'), isManager()); } }
async function afterBulk(msg) {
  showToast(msg, 'success'); selectedKeys.clear();
  if (activeList === 'location' && locSelectedId) await showLocationContainers(locSelectedId); else if (lastSearch) await loadChemicals(lastSearch.type, lastSearch.q); else renderList();
}
async function runBulk(ids, action, payload) {
  const { data, error } = await db.rpc('inventory_bulk_container_action', { p_ids: ids, p_action: action, p: payload || {} });
  if (error) { showToast(error.message, 'error'); return null; }
  return data;
}
function wireRowTarget(target, list) {
  target.addEventListener('change', e => {
    activeList = list;
    if (e.target.matches('[data-check-all]')) {
      selectedKeys = e.target.checked ? new Set(computeRows().filter(r => r.x).map(rowKey)) : new Set();
      target.querySelectorAll('[data-check]').forEach(cb => { cb.checked = e.target.checked; });
    } else if (e.target.matches('[data-check]')) {
      const key = e.target.closest('tr').dataset.key;
      if (e.target.checked) selectedKeys.add(key); else selectedKeys.delete(key);
    }
    updateBulkBar();
  });
  target.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    activeList = list;
    const holder = btn.closest('[data-key]');
    const r = currentRows.find(z => rowKey(z) === holder?.dataset.key) || computeRows().find(z => rowKey(z) === holder?.dataset.key);
    if (!r) return;
    const act = btn.dataset.act;
    if (act === 'info') openChemical(r.c.id, r.x?.id || null);
    else if (act === 'move' && r.x) openContainerAction(r.x.id, 'move');
    else if (act === 'order') startOrderFor(r.c, r.x);
    else if (act === 'delete' && r.x && isManager()) {
      if (!confirm(`Delete container ${r.x.barcode || ''} of "${r.c.name}"? It is archived as disposed and kept in the history.`)) return;
      const res = await runBulk([r.x.id], 'dispose');
      if (res) await afterBulk(res.done ? 'Container deleted.' : 'The container could not be deleted.');
    }
  });
}
wireRowTarget($('chemicalCards'), 'search');
wireRowTarget($('locationContainers'), 'location');
$('bulkMove').addEventListener('click', async () => {
  if (!isManager()) return;
  const ids = [...selectedKeys].filter(k => !k.startsWith('c:'));
  if (!ids.length) return;
  const dest = await chooseLocation(`Move ${ids.length} container(s) to…`);
  if (!dest) return;
  const res = await runBulk(ids, 'move', { location_id: dest });
  if (res) await afterBulk(`Moved ${res.done} container(s)${res.skipped ? `, ${res.skipped} skipped` : ''}.`);
});
$('bulkDelete').addEventListener('click', async () => {
  if (!isManager()) return;
  const ids = [...selectedKeys].filter(k => !k.startsWith('c:'));
  if (!ids.length || !confirm(`Delete ${ids.length} container(s)? They are archived as disposed and kept in the history.`)) return;
  const res = await runBulk(ids, 'dispose');
  if (res) await afterBulk(`Deleted ${res.done} container(s)${res.skipped ? `, ${res.skipped} skipped` : ''}.`);
});
function startOrderFor(c, x) {
  setTab('orders');
  const f = $('orderForm');
  f.elements.chemical_name.value = c.name || ''; f.elements.cas.value = c.cas || '';
  f.elements.container_size.value = x?.container_size || ''; if (x?.unit) f.elements.unit.value = x.unit;
  f.elements.supplier.value = x?.supplier || '';
}

/* ---------- location contents (Locations page: "view all") ---------- */
async function showLocationContainers(locId) {
  const loc = locations.find(l => l.id === locId); if (!loc) return;
  clearResults();
  activeList = 'location'; selectedKeys = new Set();
  locSelectedId = locId;
  show($('locationContents'), true);
  $('locationContentsTitle').textContent = 'Containers';
  status('Loading containers…', 'locationStatus');
  try {
    const ids = descendantIds(locId);
    const hits = (await fetchIn('inventory_containers', 'location_id', ids)).filter(isActiveContainer);
    const chemicalIds = [...new Set(hits.map(x => x.chemical_id))];
    const chems = await fetchIn('inventory_chemicals', 'id', chemicalIds);
    lastChemicals = chems.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    lastContainers = (await fetchIn('inventory_containers', 'chemical_id', chemicalIds)).filter(isActiveContainer);
    matchedContainerIds = new Set(hits.map(x => x.id)); lastSearch = null;
    status('', 'locationStatus');
    $('locationContents').dataset.locId = locId;
    show($('locMoveAll'), isManager()); show($('locDeleteAll'), isManager());
    renderList();
  } catch (err) { status(errorText(err), 'locationStatus'); }
}
$('locMoveAll').addEventListener('click', async () => {
  const ids = computeRows().filter(r => r.x).map(r => r.x.id);
  if (!ids.length) return showToast('There are no containers to move.', 'error');
  const dest = await chooseLocation(`Move all ${ids.length} container(s) to…`);
  if (!dest) return;
  const res = await runBulk(ids, 'move', { location_id: dest });
  if (res) await afterBulk(`Moved ${res.done} container(s)${res.skipped ? `, ${res.skipped} skipped` : ''}.`);
});
$('locDeleteAll').addEventListener('click', async () => {
  const ids = computeRows().filter(r => r.x).map(r => r.x.id);
  if (!ids.length) return showToast('There are no containers to delete.', 'error');
  if (!confirm(`Delete ALL ${ids.length} container(s) in this location? They are archived as disposed and kept in the history.`)) return;
  const res = await runBulk(ids, 'dispose');
  if (res) await afterBulk(`Deleted ${res.done} container(s).`);
});

/* ---------- GHS hazard statements ---------- */
const GHS = [
  ['H200', 'Unstable Explosive'], ['H201', 'Explosive; mass explosion hazard'], ['H202', 'Explosive; severe projection hazard'], ['H203', 'Explosive; fire, blast or projection hazard'], ['H204', 'Fire or projection hazard'], ['H205', 'May mass explode in fire'],
  ['H220', 'Extremely flammable gas'], ['H221', 'Flammable gas'], ['H222', 'Extremely flammable aerosol'], ['H223', 'Flammable aerosol'], ['H224', 'Extremely flammable liquid and vapour'], ['H225', 'Highly flammable liquid and vapour'], ['H226', 'Flammable liquid and vapour'], ['H228', 'Flammable solid'],
  ['H229', 'Pressurized container: may burst if heated'], ['H230', 'May react explosively even in the absence of air'], ['H231', 'May react explosively even in the absence of air at elevated pressure and/or temperature'], ['H240', 'Heating may cause an explosion'], ['H241', 'Heating may cause a fire or explosion'], ['H242', 'Heating may cause a fire'],
  ['H250', 'Catches fire spontaneously if exposed to air'], ['H251', 'Self-heating; may catch fire'], ['H252', 'Self-heating in large quantities; may catch fire'], ['H260', 'In contact with water releases flammable gases which may ignite spontaneously'], ['H261', 'In contact with water releases flammable gas'],
  ['H270', 'May cause or intensify fire; oxidiser'], ['H271', 'May cause fire or explosion; strong oxidiser'], ['H272', 'May intensify fire; oxidiser'], ['H280', 'Contains gas under pressure; may explode if heated'], ['H281', 'Contains refrigerated gas; may cause cryogenic burns or injury'],
  ['H290', 'May be corrosive to metals'],
  ['H300', 'Fatal if swallowed'], ['H301', 'Toxic if swallowed'], ['H302', 'Harmful if swallowed'], ['H304', 'May be fatal if swallowed and enters airways'], ['H310', 'Fatal in contact with skin'], ['H311', 'Toxic in contact with skin'], ['H312', 'Harmful in contact with skin'],
  ['H314', 'Causes severe skin burns and eye damage'], ['H315', 'Causes skin irritation'], ['H317', 'May cause an allergic skin reaction'], ['H318', 'Causes serious eye damage'], ['H319', 'Causes serious eye irritation'],
  ['H330', 'Fatal if inhaled'], ['H331', 'Toxic if inhaled'], ['H332', 'Harmful if inhaled'], ['H334', 'May cause allergy or asthma symptoms or breathing difficulties if inhaled'], ['H335', 'May cause respiratory irritation'], ['H336', 'May cause drowsiness or dizziness'],
  ['H340', 'May cause genetic defects'], ['H341', 'Suspected of causing genetic defects'], ['H350', 'May cause cancer'], ['H351', 'Suspected of causing cancer'], ['H360', 'May damage fertility or the unborn child'], ['H361', 'Suspected of damaging fertility or the unborn child'], ['H362', 'May cause harm to breast-fed children'],
  ['H370', 'Causes damage to organs'], ['H371', 'May cause damage to organs'], ['H372', 'Causes damage to organs through prolonged or repeated exposure'], ['H373', 'May cause damage to organs through prolonged or repeated exposure'],
  ['H400', 'Very toxic to aquatic life'], ['H410', 'Very toxic to aquatic life with long lasting effects'], ['H411', 'Toxic to aquatic life with long lasting effects'], ['H412', 'Harmful to aquatic life with long lasting effects'], ['H413', 'May cause long lasting harmful effects to aquatic life'], ['H420', 'Harms public health and the environment by destroying ozone in the upper atmosphere']
];
const PICTOGRAMS = [
  ['Explosive', 'fa-bomb', /^H20[0-5]$|^H240$|^H241$/], ['Flammable', 'fa-fire', /^H22[0-9]$|^H24[12]$|^H25[0-2]$|^H26[01]$/], ['Oxidising', 'fa-circle-radiation', /^H27[0-2]$/], ['Gas under pressure', 'fa-oil-can', /^H28[01]$/],
  ['Corrosive', 'fa-vial-circle-check', /^H290$|^H314$|^H318$/], ['Acute toxicity', 'fa-skull-crossbones', /^H30[01]$|^H31[01]$|^H33[01]$/], ['Irritant / harmful', 'fa-exclamation', /^H302$|^H312$|^H332$|^H31[579]$|^H33[56]$/],
  ['Health hazard', 'fa-user-doctor', /^H304$|^H334$|^H34[01]$|^H35[01]$|^H36[0-2]$|^H37[0-3]$/], ['Environmental hazard', 'fa-fish', /^H400$|^H41[0-3]$/]
];
const ghsList = (c) => (Array.isArray(c?.ghs_codes) ? c.ghs_codes : []);
function pictogramsFor(codes) {
  return PICTOGRAMS.filter(([, , re]) => codes.some(code => re.test(code))).map(([label, icon]) => `<span class="ghs-pict" title="${esc(label)}"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>`).join('');
}
function ghsSummaryHtml(c) {
  const codes = ghsList(c);
  if (!codes.length) return '<p class="muted">No hazard codes recorded for this chemical.</p>';
  return `<div class="ghs-picts">${pictogramsFor(codes)}</div><p>Hazard Codes: ${codes.map(k => `<span class="dotted" title="${esc(GHS.find(g => g[0] === k)?.[1] || '')}">${esc(k)}</span>`).join(' ')}</p>`;
}
function renderGhsPicker(listEl, filterEl, selected, onChange) {
  const draw = () => {
    const q = filterEl.value.trim().toLowerCase();
    listEl.replaceChildren(...GHS.filter(([code, text]) => !q || code.toLowerCase().includes(q) || text.toLowerCase().includes(q)).map(([code, text]) => {
      const row = document.createElement('label'); row.className = 'ghs-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(code);
      cb.addEventListener('change', () => { if (cb.checked) selected.add(code); else selected.delete(code); onChange(); });
      const a = document.createElement('b'); a.textContent = code; const b = document.createElement('span'); b.textContent = text;
      row.append(cb, a, b); return row;
    }));
  };
  filterEl.oninput = draw; draw();
}
/* GHS search */
const ghsSel = new Set();
function drawGhsSelected() { $('ghsSelected').innerHTML = ghsSel.size ? [...ghsSel].sort().map(c => `<span class="badge">${esc(c)}</span>`).join(' ') : '<i>Select items from the list below</i>'; }
$('openGhs')?.addEventListener('click', () => { $('ghsFilter').value = ''; renderGhsPicker($('ghsList'), $('ghsFilter'), ghsSel, drawGhsSelected); drawGhsSelected(); status('', 'ghsStatus'); $('ghsSearchDialog').showModal(); });
$('ghsRun').addEventListener('click', async () => {
  if (!ghsSel.size) return status('Select at least one hazard code.', 'ghsStatus');
  const mode = document.querySelector('input[name="ghsMode"]:checked').value, want = [...ghsSel];
  $('ghsRun').disabled = true; status('Searching…', 'ghsStatus');
  try {
    await runSnapshotSearch(({ c }) => {
      const have = ghsList(c).map(k => k.toUpperCase());
      if (!have.length) return false;
      if (mode === 'and') return want.every(k => have.includes(k));
      if (mode === 'only') return have.every(k => want.includes(k));
      return want.some(k => have.includes(k));
    });
    $('ghsSearchDialog').close();
  } catch (err) { status(errorText(err), 'ghsStatus'); } finally { $('ghsRun').disabled = false; }
});

/* ---------- snapshot search (advanced + GHS) ---------- */
async function fetchSnapshot() {
  const [chemicals, containers] = await Promise.all([
    fetchAll(() => db.from('inventory_chemicals').select('*').order('id')),
    fetchAll(() => db.from('inventory_containers').select('*').order('id'))
  ]);
  return { chemicals, containers: containers.filter(isActiveContainer) };
}
async function runSnapshotSearch(test, snapshot = null) {
  const snap = snapshot || await fetchSnapshot();
  const byChem = new Map(snap.chemicals.map(c => [c.id, c]));
  const hits = snap.containers.filter(x => byChem.has(x.chemical_id) && test({ c: byChem.get(x.chemical_id), x }));
  const ids = new Set(hits.map(x => x.chemical_id));
  clearResults();
  activeList = 'search'; selectedKeys = new Set(); searchSeq++;
  lastChemicals = snap.chemicals.filter(c => ids.has(c.id)).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  lastContainers = snap.containers.filter(x => ids.has(x.chemical_id));
  matchedContainerIds = new Set(hits.map(x => x.id));
  lastSearch = null;
  show($('chemoraResultsPanel'), true); show($('locationContents'), false);
  status('', 'searchStatus');
  renderList();
}

/* ---------- advanced search ---------- */
const ADV_FIELDS = {
  name: { label: 'Container name (with synonyms)', type: 'text' },
  name_exact: { label: 'Container name (no synonyms)', type: 'text' },
  cas: { label: 'CAS number', type: 'text' },
  barcode: { label: 'Barcode', type: 'text' },
  supplier: { label: 'Supplier', type: 'text' },
  catalog: { label: 'Catalog number', type: 'text' },
  lot: { label: 'Lot number', type: 'text' },
  comments: { label: 'Comments', type: 'text' },
  location: { label: 'Location (path)', type: 'text' },
  owner: { label: 'Owner', type: 'text' },
  acquired: { label: 'Date acquired', type: 'date' },
  expires: { label: 'Expiry date', type: 'date' },
  size: { label: 'Container size', type: 'number' },
  remaining: { label: 'Remaining amount', type: 'number' },
  ghs: { label: 'GHS hazard code', type: 'text' },
  has_ghs: { label: 'Has GHS data', type: 'bool' },
  valid_cas: { label: 'Has a valid CAS number', type: 'bool' },
  empty: { label: 'Is empty (no remaining amount)', type: 'bool' }
};
const ADV_OPS = {
  text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'is exactly'], ['starts', 'starts with'], ['blank', 'is blank']],
  date: [['on', 'is on'], ['before', 'is before'], ['after', 'is after'], ['blank', 'is blank']],
  number: [['eq', '='], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤']],
  bool: [['yes', 'Yes'], ['no', 'No']]
};
let advRoot = { type: 'group', op: 'AND', items: [{ type: 'rule', field: '', operator: '', value: '' }] };
function advNew() { return { type: 'rule', field: '', operator: '', value: '' }; }
function renderAdvanced() {
  const host = $('advancedBuilder'); host.replaceChildren();
  const group = (g, parent) => {
    const box = document.createElement('div'); box.className = 'adv-group';
    const head = document.createElement('div'); head.className = 'adv-head';
    const ops = document.createElement('span'); ops.className = 'view-toggle';
    for (const op of ['AND', 'OR']) { const b = document.createElement('button'); b.type = 'button'; b.textContent = op; b.className = g.op === op ? 'active' : ''; b.addEventListener('click', () => { g.op = op; renderAdvanced(); }); ops.append(b); }
    const addRule = document.createElement('button'); addRule.type = 'button'; addRule.className = 'btn green small'; addRule.innerHTML = '<i class="fa-solid fa-plus"></i> Add rule'; addRule.addEventListener('click', () => { g.items.push(advNew()); renderAdvanced(); });
    const addGroup = document.createElement('button'); addGroup.type = 'button'; addGroup.className = 'btn green small'; addGroup.innerHTML = '<i class="fa-solid fa-circle-plus"></i> Add group'; addGroup.addEventListener('click', () => { g.items.push({ type: 'group', op: 'AND', items: [advNew()] }); renderAdvanced(); });
    const spacer = document.createElement('span'); spacer.style.flex = '1';
    head.append(ops, spacer, addRule, addGroup);
    if (parent) { const del = document.createElement('button'); del.type = 'button'; del.className = 'btn danger small'; del.innerHTML = '<i class="fa-solid fa-xmark"></i> Delete'; del.addEventListener('click', () => { parent.items.splice(parent.items.indexOf(g), 1); renderAdvanced(); }); head.append(del); }
    box.append(head);
    const body = document.createElement('div'); body.className = 'adv-body';
    g.items.forEach(item => {
      if (item.type === 'group') { body.append(group(item, g)); return; }
      const row = document.createElement('div'); row.className = 'adv-rule';
      const fsel = document.createElement('select'); fsel.append(new Option('------', ''), ...Object.entries(ADV_FIELDS).map(([k, v]) => new Option(v.label, k))); fsel.value = item.field;
      fsel.addEventListener('change', () => { item.field = fsel.value; item.operator = item.field ? ADV_OPS[ADV_FIELDS[item.field].type][0][0] : ''; item.value = ''; renderAdvanced(); });
      row.append(fsel);
      if (item.field) {
        const def = ADV_FIELDS[item.field];
        const osel = document.createElement('select'); osel.append(...ADV_OPS[def.type].map(([k, v]) => new Option(v, k))); osel.value = item.operator || ADV_OPS[def.type][0][0]; item.operator = osel.value;
        osel.addEventListener('change', () => { item.operator = osel.value; renderAdvanced(); });
        row.append(osel);
        if (def.type !== 'bool' && item.operator !== 'blank') {
          const inp = document.createElement('input'); inp.type = def.type === 'date' ? 'date' : def.type === 'number' ? 'number' : 'text'; if (def.type === 'number') inp.step = 'any'; inp.value = item.value; inp.placeholder = 'Value';
          inp.addEventListener('input', () => { item.value = inp.value; }); inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('advancedRun').click(); } });
          row.append(inp);
        }
      }
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn danger small'; del.innerHTML = '<i class="fa-solid fa-xmark"></i> Delete';
      del.addEventListener('click', () => { g.items.splice(g.items.indexOf(item), 1); if (!g.items.length && !parent) g.items.push(advNew()); renderAdvanced(); });
      row.append(del); body.append(row);
    });
    box.append(body); return box;
  };
  host.append(group(advRoot, null));
}
function advRuleTest(rule, ctx) {
  const def = ADV_FIELDS[rule.field]; if (!def) return true;
  const { c, x, syn } = ctx;
  const text = v => String(v ?? '').toLowerCase();
  const loc = x && locations.find(l => l.id === x.location_id);
  const get = {
    name: () => [c.name, ...(syn.get(c.id) || [])].map(text), name_exact: () => [text(c.name)], cas: () => [text(c.cas)], barcode: () => [text(x?.barcode)], supplier: () => [text(x?.supplier)],
    catalog: () => [text(x?.catalog_number)], lot: () => [text(x?.lot_number)], comments: () => [text(x?.notes), text(c.notes)], location: () => [text(loc ? locationPath(loc) : '')], owner: () => [text(ownerName(x?.owner_id))],
    ghs: () => ghsList(c).map(text)
  };
  if (def.type === 'text') {
    const vals = (get[rule.field] ? get[rule.field]() : ['']), q = text(rule.value);
    switch (rule.operator) {
      case 'contains': return vals.some(v => v.includes(q));
      case 'not_contains': return !vals.some(v => v.includes(q));
      case 'equals': return vals.some(v => v === q);
      case 'starts': return vals.some(v => v.startsWith(q));
      case 'blank': return vals.every(v => v === '');
      default: return true;
    }
  }
  if (def.type === 'date') {
    const v = rule.field === 'acquired' ? x?.received_at : x?.expires_at, q = rule.value;
    if (rule.operator === 'blank') return !v;
    if (!v || !q) return false;
    return rule.operator === 'on' ? v === q : rule.operator === 'before' ? v < q : v > q;
  }
  if (def.type === 'number') {
    const v = Number(rule.field === 'size' ? x?.container_size : (x?.remaining_amount ?? x?.container_size)), q = Number(rule.value);
    if (!Number.isFinite(v) || rule.value === '' || !Number.isFinite(q)) return false;
    return { eq: v === q, gt: v > q, lt: v < q, gte: v >= q, lte: v <= q }[rule.operator];
  }
  const truth = rule.field === 'has_ghs' ? ghsList(c).length > 0 : rule.field === 'valid_cas' ? Boolean(c.cas && validCAS(c.cas)) : Number(x?.remaining_amount ?? x?.container_size) === 0;
  return rule.operator === 'yes' ? truth : !truth;
}
function advEval(node, ctx) {
  if (node.type === 'rule') return advRuleTest(node, ctx);
  const parts = node.items.filter(i => i.type === 'group' || i.field);
  if (!parts.length) return true;
  return node.op === 'AND' ? parts.every(i => advEval(i, ctx)) : parts.some(i => advEval(i, ctx));
}
$('openAdvanced')?.addEventListener('click', () => { renderAdvanced(); status('', 'advancedStatus'); $('advancedDialog').showModal(); });
$('advancedRun').addEventListener('click', async () => {
  $('advancedRun').disabled = true; status('Searching…', 'advancedStatus');
  try {
    const snap = await fetchSnapshot();
    const syn = new Map();
    try { for (const s of await fetchAll(() => db.from('inventory_chemical_synonyms').select('chemical_id,synonym').order('id'))) { if (!syn.has(s.chemical_id)) syn.set(s.chemical_id, []); syn.get(s.chemical_id).push(s.synonym); } } catch (_e) { /* synonyms are optional */ }
    await runSnapshotSearch(({ c, x }) => advEval(advRoot, { c, x, syn }), snap);
    $('advancedDialog').close();
  } catch (err) { status(errorText(err), 'advancedStatus'); } finally { $('advancedRun').disabled = false; }
});

/* ---------- add a container (two steps, toggles, location tree, hazard codes) ---------- */
function setAddStep(step) { show($('addStep1'), step === 1); show($('addStep2'), step === 2); status('', 'addStatus'); }
$('noCasToggle').addEventListener('click', () => {
  const f = $('addChemical').elements.cas, off = !f.disabled;
  f.disabled = off; f.value = ''; f.placeholder = off ? 'No CAS number' : 'CAS Registry Number';
  $('noCasToggle').textContent = off ? '[enter a CAS number]' : '[no CAS number?]';
});
$('noBarcodeToggle').addEventListener('click', () => {
  const f = $('addChemical').elements.barcode, off = !f.disabled;
  f.disabled = off; f.value = ''; f.placeholder = off ? 'A barcode will be generated automatically' : 'Barcode Number (leave empty to generate)';
  $('noBarcodeToggle').textContent = off ? '[enter a barcode]' : '[no barcode?]';
});
$('addCommentButton').addEventListener('click', () => { show($('addCommentField'), true); $('addChemical').elements.notes.focus(); });
$('addNext').addEventListener('click', () => {
  const f = $('addChemical'), msg = text => status(text, 'addStatus');
  const name = val(f, 'name'), cas = val(f, 'cas'), size = Number(val(f, 'container_size'));
  if (!name) return msg('Container name is required.');
  if (cas && !validCAS(cas)) return msg('Invalid CAS checksum.');
  if (!(size > 0) || !Number.isFinite(size)) return msg('Container size must be positive.');
  if (!val(f, 'location_id')) return msg('Choose a location for the container.');
  setAddStep(2);
});
$('addBack').addEventListener('click', () => setAddStep(1));
let addGhs = new Set();
function drawAddGhs() { $('addGhsSummary').textContent = addGhs.size ? [...addGhs].sort().join(', ') : 'None selected'; $('addGhsValue').value = JSON.stringify([...addGhs]); }
let ghsEditTarget = null, ghsEditSel = new Set();
function openGhsEditor(initial, onSave) {
  ghsEditSel = new Set(initial); ghsEditTarget = onSave; $('ghsEditFilter').value = '';
  renderGhsPicker($('ghsEditList'), $('ghsEditFilter'), ghsEditSel, () => {});
  $('ghsEditDialog').showModal();
}
$('ghsEditSave').addEventListener('click', async () => { const f = ghsEditTarget; ghsEditTarget = null; $('ghsEditDialog').close(); if (f) await f([...ghsEditSel].sort()); });
$('addGhsButton').addEventListener('click', () => openGhsEditor(addGhs, codes => { addGhs = new Set(codes); drawAddGhs(); }));
function resetAddForm() { addGhs = new Set(); drawAddGhs(); setAddStep(1); for (const id of ['noCasToggle', 'noBarcodeToggle']) { const f = $('addChemical').elements[id === 'noCasToggle' ? 'cas' : 'barcode']; if (f.disabled) $(id).click(); } show($('addCommentField'), false); $('chemicalLocation').value = ''; renderLocationUi(); }
function prefillDuplicate(c, x) {
  setTab('add');
  const f = $('addChemical'); f.reset(); resetAddForm();
  f.elements.name.value = c.name || ''; f.elements.cas.value = c.cas || ''; f.elements.formula.value = c.formula || '';
  if (x) { f.elements.container_size.value = x.container_size || ''; f.elements.unit.value = x.unit || 'g'; f.elements.supplier.value = x.supplier || ''; f.elements.catalog_number.value = x.catalog_number || ''; f.elements.lot_number.value = x.lot_number || ''; f.elements.purity.value = x.purity || ''; f.elements.notes.value = x.notes || ''; if (x.notes) show($('addCommentField'), true); $('chemicalLocation').value = x.location_id || ''; renderLocationUi(); }
  addGhs = new Set(ghsList(c)); drawAddGhs();
  status('Duplicating "' + c.name + '": a new barcode is generated automatically.', 'addStatus');
}

async function showContainerHistory(containerId) {
  const x = lastContainers.find(z => z.id === containerId); if (!x || !isManager()) return;
  const c = lastChemicals.find(z => z.id === x.chemical_id);
  $('historyDialogSummary').textContent = `${c?.name || 'Container'} (${x.barcode || 'no barcode'})`;
  $('historyDialogList').innerHTML = '<p class="muted">Loading…</p>';
  $('historyDialog').showModal();
  let { data, error } = await db.from('inventory_activity_logs').select('created_at,action,performed_by,description').eq('record_id', containerId).order('created_at', { ascending: false }).limit(200);
  if (error && /description/i.test(error.message)) ({ data, error } = await db.from('inventory_activity_logs').select('created_at,action,performed_by').eq('record_id', containerId).order('created_at', { ascending: false }).limit(200));
  if (error) { $('historyDialogList').textContent = error.message; return; }
  $('historyDialogList').innerHTML = (data || []).length ? '<table class="inventory-data-table"><thead><tr><th>Timestamp (UTC)</th><th>User</th><th>Event</th><th>Description</th></tr></thead><tbody>' +
    data.map(h => `<tr><td>${esc(String(h.created_at).replace('T', ' ').slice(0, 19))}</td><td>${esc(ownerName(h.performed_by) || '—')}</td><td>${esc(EVENT_LABELS[h.action] || h.action)}</td><td>${esc(h.description || '')}</td></tr>`).join('') + '</tbody></table>' : '<p class="muted">No history recorded for this container.</p>';
}

/* ---------- orders: no-CAS toggle ---------- */
$('orderNoCas')?.addEventListener('click', () => {
  const f = $('orderForm').elements.cas, on = !f.disabled;
  f.disabled = on; if (on) f.value = '';
  $('orderNoCas').textContent = on ? '[has a CAS number?]' : '[no CAS number?]';
});

/* ---------- Labs & All Users (Inventory Administrator only) ---------- */
let platformLabs = [], platformUsers = [];
const roleLabel = r => r === 'admin' ? 'Administrator' : r === 'manager' ? 'Chemical Manager' : 'Member';
async function loadPlatform() {
  if (!labContext?.platform_admin) return;
  $('labTable').textContent = 'Loading labs…'; $('allUsersTable').textContent = 'Loading users…';
  const [labs, users] = await Promise.all([db.rpc('inventory_list_labs'), db.rpc('inventory_list_all_users')]);
  if (labs.error) $('labTable').textContent = labs.error.message; else { platformLabs = labs.data || []; renderPlatformLabs(); }
  if (users.error) $('allUsersTable').textContent = users.error.message; else { platformUsers = users.data || []; renderPlatformUsers(); }
}
function renderPlatformLabs() {
  $('labTable').innerHTML = platformLabs.length ? '<table class="inventory-data-table"><thead><tr><th>Lab</th><th>Barcode prefix</th><th>Lab administrators</th><th>Members</th><th>Containers</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
    platformLabs.map(l => `<tr class="${l.active ? '' : 'is-locked'}"><td><strong>${esc(l.name)}</strong></td><td>${esc(l.barcode_prefix)}</td><td>${l.admins ? esc(l.admins) : '<span class="order-badge ordered">Administrator required</span>'}</td><td>${esc(l.member_count)}</td><td>${esc(l.container_count)}</td><td>${l.active ? 'Active' : 'Inactive'}</td><td><span class="row-actions">` +
      `<button type="button" class="icon-btn" data-lab-rename="${esc(l.id)}" title="Rename lab" aria-label="Rename lab"><i class="fa-solid fa-pen-to-square"></i></button>` +
      `<button type="button" class="icon-btn" data-lab-admin="${esc(l.id)}" title="Change lab administrator" aria-label="Change lab administrator"><i class="fa-solid fa-user-shield"></i></button>` +
      `<button type="button" class="icon-btn" data-lab-toggle="${esc(l.id)}" title="${l.active ? 'Deactivate lab' : 'Activate lab'}" aria-label="${l.active ? 'Deactivate lab' : 'Activate lab'}"><i class="fa-solid ${l.active ? 'fa-ban' : 'fa-rotate-left'}"></i></button>` +
      '</span></td></tr>').join('') + '</tbody></table>' : '<p class="muted" style="padding:10px">No labs yet.</p>';
}
$('labTable').addEventListener('click', async e => {
  const open = e.target.closest('[data-lab-open]'), ren = e.target.closest('[data-lab-rename]'), tog = e.target.closest('[data-lab-toggle]'), adm = e.target.closest('[data-lab-admin]');
  try {
    if (adm) {
      const l = platformLabs.find(x => x.id === adm.dataset.labAdmin);
      openLabAdminDialog(l.id, l.name, platformUsers.filter(u => !u.platform_admin && u.account_status !== 'locked').map(u => u.email), 'Choose an existing account from the list or type an e-mail address to invite someone new. Current administrator: ' + (l.admins || 'none') + '.');
      return;
    }
    if (open) { await switchLab(open.dataset.labOpen); return; }
    if (ren) {
      const l = platformLabs.find(x => x.id === ren.dataset.labRename), name = (prompt('Lab name', l.name) || '').trim();
      if (!name || name === l.name) return;
      const { error } = await db.rpc('inventory_update_lab', { p_lab_id: l.id, p_name: name, p_active: null }); if (error) throw error;
      status('Lab renamed.');
    } else if (tog) {
      const l = platformLabs.find(x => x.id === tog.dataset.labToggle);
      if (l.active && !confirm(`Deactivate "${l.name}"? Its members will not be able to sign in until you activate it again. Nothing is deleted.`)) return;
      const { error } = await db.rpc('inventory_update_lab', { p_lab_id: l.id, p_name: null, p_active: !l.active }); if (error) throw error;
      status(l.active ? 'Lab deactivated.' : 'Lab activated.');
    } else return;
    const ctx = await db.rpc('inventory_my_context'); if (!ctx.error && ctx.data) { labContext = ctx.data; renderLabControls(); }
    await loadPlatform();
  } catch (err) { status(errorText(err)); }
});
function renderPlatformUsers() {
  const q = ($('allUsersFilter').value || '').trim().toLowerCase();
  const rows = platformUsers.filter(u => !q || [u.full_name, u.email, ...(u.labs || []).map(l => l.lab_name)].some(v => String(v || '').toLowerCase().includes(q)));
  $('allUsersTable').innerHTML = rows.length ? '<table class="inventory-data-table"><thead><tr><th>Name</th><th>Email</th><th>Labs and account type</th><th>Actions</th></tr></thead><tbody>' +
    rows.map(u => { const locked = u.account_status === 'locked', me = u.user_id === user.id;
      return `<tr class="${locked ? 'is-locked' : ''}"><td><strong>${esc(u.full_name || 'User')}</strong>${u.platform_admin ? ' <span class="order-badge received">Inventory Administrator</span>' : ''}${locked ? ' <span class="order-badge ordered">Locked</span>' : ''}</td><td>${esc(u.email || '—')}</td><td>${(u.labs || []).map(l => `<span class="au-lab">${esc(l.lab_name)} <span class="muted">(${esc(roleLabel(l.role))})</span>${u.platform_admin ? '' : ` <button type="button" class="icon-btn au-remove" data-au-remove="${esc(u.user_id)}" data-au-lab="${esc(l.lab_id)}" title="Remove from ${esc(l.lab_name)}" aria-label="Remove from ${esc(l.lab_name)}"><i class="fa-solid fa-xmark"></i></button>`}</span>`).join('<br>') || '<span class="muted">No lab</span>'}</td><td><span class="row-actions">` +
        (me ? '' : `<button type="button" class="icon-btn" data-au-lock="${esc(u.user_id)}" title="${locked ? 'Unlock account' : 'Lock account'}" aria-label="${locked ? 'Unlock account' : 'Lock account'}"><i class="fa-solid ${locked ? 'fa-lock-open' : 'fa-lock'}"></i></button><button type="button" class="icon-btn" data-au-edit="${esc(u.user_id)}" title="Edit name and e-mail" aria-label="Edit name and e-mail"><i class="fa-solid fa-pen-to-square"></i></button><button type="button" class="icon-btn" data-au-pass="${esc(u.user_id)}" title="Set new password" aria-label="Set new password"><i class="fa-solid fa-key"></i></button>${u.platform_admin ? '' : (u.labs || []).length ? `<button type="button" class="icon-btn" data-au-delete="${esc(u.user_id)}" title="Delete account (every lab)" aria-label="Delete account (every lab)"><i class="fa-solid fa-trash"></i></button>` : `<button type="button" class="icon-btn" data-au-purge="${esc(u.user_id)}" title="Delete permanently (not in any lab)" aria-label="Delete permanently"><i class="fa-solid fa-user-xmark"></i></button>`}`) +
        '</span></td></tr>'; }).join('') + '</tbody></table>' : '<p class="muted" style="padding:10px">No matching users.</p>';
}
$('allUsersFilter').addEventListener('input', renderPlatformUsers);
$('refreshPlatform').addEventListener('click', loadPlatform);
/* ---------- change the lab administrator (Inventory Administrator, or the lab's own administrator) ---------- */
let labAdminTarget = null;
function openLabAdminDialog(labId, labName, emails, help) {
  labAdminTarget = { id: labId, name: labName };
  $('labAdminHelp').textContent = labName + ': ' + help;
  $('labAdminList').innerHTML = [...new Set((emails || []).filter(Boolean))].sort().map(m => `<option value="${esc(m)}"></option>`).join('');
  $('labAdminForm').reset();
  $('labAdminDialog').showModal();
}
$('changeAdminButton')?.addEventListener('click', () => openLabAdminDialog(labContext.lab_id, labContext.lab_name || 'This lab',
  cachedUsers.filter(u => (u.user_id || u.id) !== user.id && u.account_status !== 'locked').map(u => u.email),
  'Choose another member of this lab to become the administrator. You will become a Chemical Manager.'));
$('labAdminForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget, email = val(f, 'email').toLowerCase(), submit = f.querySelector('[type="submit"]');
  if (!labAdminTarget) return;
  if (email === String(user.email || '').toLowerCase()) { $('labAdminDialog').close(); return status('You are already the administrator.'); }
  if (!confirm('Make ' + email + ' the administrator of ' + labAdminTarget.name + '? The previous administrator becomes a Chemical Manager.')) return;
  submit.disabled = true;
  try {
    const { data, error } = await db.rpc('inventory_change_lab_admin', { p_lab_id: labAdminTarget.id, p_email: email });
    if (error) throw error;
    $('labAdminDialog').close();
    if (labContext?.platform_admin) {
      await loadPlatform();
      status(data === 'pending' ? email + ' will become the administrator of ' + labAdminTarget.name + ' when they register.' : email + ' is now the administrator of ' + labAdminTarget.name + '.');
    } else {
      status(email + ' is now the administrator. Reloading…');
      setTimeout(() => location.reload(), 1200);
    }
  } catch (err) { status(errorText(err)); } finally { submit.disabled = false; }
});
$('allUsersTable').addEventListener('click', async e => {
  const lock = e.target.closest('[data-au-lock]'), pass = e.target.closest('[data-au-pass]'), del = e.target.closest('[data-au-delete]'), edit = e.target.closest('[data-au-edit]'), rem = e.target.closest('[data-au-remove]'), purge = e.target.closest('[data-au-purge]');
  const id = (lock || pass || del || edit || rem || purge)?.dataset[lock ? 'auLock' : pass ? 'auPass' : del ? 'auDelete' : edit ? 'auEdit' : purge ? 'auPurge' : 'auRemove']; if (!id) return;
  const u = platformUsers.find(x => x.user_id === id);
  try {
    if (rem) {
      const lab = (u.labs || []).find(l => l.lab_id === rem.dataset.auLab);
      if (!confirm('Remove ' + (u.email || u.full_name) + ' from ' + (lab?.lab_name || 'this lab') + '? Their account stays active in any other lab. Containers and history are kept.')) return;
      await invokeUsers({ action: 'delete', userId: id, labId: rem.dataset.auLab });
    } else if (edit) {
      const name = prompt('Full name', u.full_name || ''); if (name === null) return;
      const email = prompt('E-mail address', u.email || ''); if (email === null) return;
      if (!name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return status('Enter a name and a valid e-mail address.');
      await invokeUsers({ action: 'update', userId: id, name: name.trim(), email: email.trim().toLowerCase(), global: true });
    } else if (lock) await invokeUsers({ action: u.account_status === 'locked' ? 'unlock' : 'lock', userId: id, global: true });
    else if (pass) {
      const pw = prompt('New password for ' + (u.email || u.full_name) + ' (12+ characters)'); if (!pw) return;
      if (pw.length < 12) return status('Password must contain at least 12 characters.');
      await invokeUsers({ action: 'update', userId: id, password: pw, global: true });
    } else if (purge) {
      const who = u.email || u.full_name;
      const typed = prompt('PERMANENTLY delete the account of ' + who + '? This cannot be undone. Containers and history they created are kept, but will no longer show their name.\n\nType the e-mail address to confirm:');
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== String(u.email || '').toLowerCase()) return status('E-mail did not match. Nothing was deleted.');
      await invokeUsers({ action: 'purge', userId: id, global: true });
      status('Account deleted permanently.'); await loadPlatform(); return;
    } else if (del) {
      if (!confirm('Delete the account of ' + (u.email || u.full_name) + ' from every lab? It is deactivated and can no longer sign in. Containers and history are kept.')) return;
      await invokeUsers({ action: 'delete', userId: id, global: true });
    }
    status('Done.'); await loadPlatform();
  } catch (err) { status(errorText(err)); }
});

/* ---------- Table Columns ---------- */
function openColumns() {
  $('columnsList').innerHTML = Object.entries(COLUMN_DEFS).map(([k, label]) => `<label class="ci-check"><input type="checkbox" value="${k}" ${tableColumns.includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
  $('columnsDialog').showModal();
}
$('columnsSave').addEventListener('click', () => {
  tableColumns = [...$('columnsList').querySelectorAll('input:checked')].map(i => i.value);
  try { localStorage.setItem('chemora-columns', JSON.stringify(tableColumns)); } catch (_e) { /* private mode */ }
  $('columnsDialog').close();
  if (currentRows.length) renderList();
  status('Table columns saved.');
});

/* ---------- Assigned barcodes ---------- */
async function showAssignedBarcodes() {
  try {
    const rows = (await getContainerRows()).filter(x => x.barcode).sort((a, b) => String(a.barcode).localeCompare(String(b.barcode), undefined, { numeric: true }));
    $('toolsResult').innerHTML = '<h3 class="ci-bar">Assigned Barcodes</h3><p class="muted">' + rows.length + ' barcode(s) are assigned in this lab. A barcode is never reused, even after a container is deleted.</p><div class="actions"><button type="button" class="btn" id="assignedDownload">Download list</button></div><table class="inventory-data-table"><thead><tr><th>Barcode</th><th>Container</th><th>Status</th><th>Location</th></tr></thead><tbody>' +
      rows.map(x => `<tr><td>${esc(x.barcode)}</td><td>${esc(x.chemical?.name)}</td><td>${isActiveContainer(x) ? 'In inventory' : 'Deleted'}</td><td>${esc(x.location_name)}</td></tr>`).join('') + '</tbody></table>';
    $('assignedDownload').addEventListener('click', () => downloadCSV('assigned-barcodes.csv', [['Barcode', 'Container', 'Status', 'Location'], ...rows.map(x => [x.barcode, x.chemical?.name, isActiveContainer(x) ? 'In inventory' : 'Deleted', x.location_name])]));
  } catch (e) { status(errorText(e)); }
}

/* ---------- Bulk container update ---------- */
const BULK_FIELDS = ['supplier', 'catalog_number', 'lot_number', 'purity', 'received_at', 'expires_at', 'notes', 'remaining_amount'];
let bulkRows = [], bulkChanges = [];
function resetBulk() { bulkChanges = []; $('bulkFile').value = ''; $('bulkPreview').replaceChildren(); show($('bulkApply'), false); status('', 'bulkStatus'); }
$('bulkDownload').addEventListener('click', async () => {
  try {
    const rows = (await getContainerRows()).filter(isActiveContainer);
    downloadCSV('chemora-bulk-update.csv', [['barcode', 'chemical', ...BULK_FIELDS], ...rows.map(x => [x.barcode, x.chemical?.name, ...BULK_FIELDS.map(k => x[k] ?? '')])]);
    status('Downloaded ' + rows.length + ' containers.', 'bulkStatus');
  } catch (e) { status(errorText(e), 'bulkStatus'); }
});
$('bulkFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  bulkChanges = []; show($('bulkApply'), false);
  try {
    const rows = parseCSV(await file.text()).filter(r => r.some(c => String(c).trim()));
    const head = (rows.shift() || []).map(h => String(h).trim().toLowerCase());
    const bi = head.indexOf('barcode');
    if (bi < 0) return status('The file needs a "barcode" column (download the current data to start from it).', 'bulkStatus');
    if (rows.length > 500) return status('Up to 500 rows can be updated at once.', 'bulkStatus');
    bulkRows = (await getContainerRows()).filter(isActiveContainer);
    const byBarcode = new Map(bulkRows.map(x => [String(x.barcode).toLowerCase(), x]));
    const problems = [];
    rows.forEach((r, i) => {
      const line = i + 2, x = byBarcode.get(String(r[bi] || '').trim().toLowerCase());
      if (!x) return problems.push(`Row ${line}: barcode "${r[bi] || ''}" not found.`);
      const patch = {}; let remaining = null;
      for (const k of BULK_FIELDS) {
        const ci = head.indexOf(k); if (ci < 0) continue;
        const raw = String(r[ci] ?? '').trim(), old = x[k] ?? '';
        if (raw === String(old)) continue;
        if (k === 'remaining_amount') {
          if (raw === '' ) continue;
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0 || n > Number(x.container_size)) { problems.push(`Row ${line}: remaining amount must be between 0 and ${x.container_size}.`); continue; }
          if (n !== Number(old)) remaining = n;
        } else if (k === 'received_at' || k === 'expires_at') {
          if (raw !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) { problems.push(`Row ${line}: ${k} must look like 2026-03-31.`); continue; }
          patch[k] = raw || null;
        } else patch[k] = raw || null;
      }
      if (Object.keys(patch).length || remaining !== null) bulkChanges.push({ x, patch, remaining });
    });
    $('bulkPreview').innerHTML = (problems.length ? '<div class="ci-box" style="border-color:#d9635d"><strong>Please fix:</strong><br>' + problems.slice(0, 20).map(esc).join('<br>') + (problems.length > 20 ? `<br>…and ${problems.length - 20} more` : '') + '</div>' : '') +
      (bulkChanges.length ? '<table class="inventory-data-table"><thead><tr><th>Barcode</th><th>Container</th><th>Change</th></tr></thead><tbody>' + bulkChanges.map(c => `<tr><td>${esc(c.x.barcode)}</td><td>${esc(c.x.chemical?.name)}</td><td>${[...Object.entries(c.patch).map(([k, v]) => `${esc(k)}: ${esc(c.x[k] ?? '—')} → <b>${esc(v ?? '—')}</b>`), ...(c.remaining !== null ? [`remaining_amount: ${esc(c.x.remaining_amount)} → <b>${esc(c.remaining)}</b>`] : [])].join('<br>')}</td></tr>`).join('') + '</tbody></table>' : '<p class="muted">No changes found.</p>');
    show($('bulkApply'), bulkChanges.length > 0 && problems.length === 0);
    status(bulkChanges.length ? `${bulkChanges.length} container(s) will change.` + (problems.length ? ' Fix the listed problems to continue.' : '') : '', 'bulkStatus');
  } catch (err) { status(errorText(err), 'bulkStatus'); }
});
$('bulkApply').addEventListener('click', async () => {
  if (!isAdmin() || !bulkChanges.length) return;
  $('bulkApply').disabled = true; let ok = 0; const failed = [];
  for (const c of bulkChanges) {
    try {
      if (Object.keys(c.patch).length) { const { error } = await updateRow('inventory_containers', c.x.id, c.patch); if (error) throw error; }
      if (c.remaining !== null) { const { error } = await db.rpc('inventory_container_action_phase3', { p_id: c.x.id, p_action: 'quantity', p: { remaining_amount: String(c.remaining) } }); if (error) throw error; }
      ok++;
    } catch (err) { failed.push(`${c.x.barcode}: ${errorText(err)}`); }
  }
  $('bulkApply').disabled = false; show($('bulkApply'), false); bulkChanges = [];
  $('bulkPreview').innerHTML = failed.length ? '<div class="ci-box" style="border-color:#d9635d"><strong>Not updated:</strong><br>' + failed.map(esc).join('<br>') + '</div>' : '';
  status(`Updated ${ok} container(s)` + (failed.length ? `, ${failed.length} failed.` : '.'), 'bulkStatus');
});

/* ---------- Stocktake & audit ---------- */
let stock = null;
function resetStock() { stock = null; show($('stockMove'), false); $('stockLocation').textContent = 'No location selected.'; $('stockScan').disabled = true; $('stockScan').value = ''; $('stockResult').replaceChildren(); status('', 'stockStatus'); }
$('stockPick').addEventListener('click', async () => {
  const id = await chooseLocation('Stocktake location'); if (!id) return;
  try {
    const loc = locations.find(l => l.id === id), ids = new Set($('stockSub').checked ? descendantIds(id) : [id]);
    const all = (await getContainerRows()).filter(isActiveContainer);
    stock = { loc, all, expected: new Map(all.filter(x => ids.has(x.location_id)).map(x => [x.id, x])), found: new Set(), unexpected: new Map(), unknown: [] };
    $('stockLocation').textContent = locationPath(loc) + ' — ' + stock.expected.size + ' container(s) expected';
    $('stockScan').disabled = false; $('stockScan').focus(); renderStock();
  } catch (e) { status(errorText(e), 'stockStatus'); }
});
$('stockScan').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !stock) return;
  e.preventDefault();
  const code = e.target.value.trim(); e.target.value = ''; if (!code) return;
  const x = stock.all.find(r => String(r.barcode).toLowerCase() === code.toLowerCase());
  if (!x) { if (!stock.unknown.includes(code)) stock.unknown.push(code); status('Unknown barcode ' + code, 'stockStatus'); }
  else if (stock.expected.has(x.id)) { stock.found.add(x.id); status(`${x.chemical?.name || 'Container'} (${x.barcode}) found.`, 'stockStatus'); }
  else { stock.unexpected.set(x.id, x); status(`${x.chemical?.name || 'Container'} (${x.barcode}) belongs to ${x.location_name || 'another location'}.`, 'stockStatus'); }
  renderStock();
});
function stockReport() {
  const rows = [];
  for (const x of stock.expected.values()) rows.push([stock.found.has(x.id) ? 'Found' : 'Missing', x.barcode, x.chemical?.name, x.location_name]);
  for (const x of stock.unexpected.values()) rows.push(['Unexpected (listed elsewhere)', x.barcode, x.chemical?.name, x.location_name]);
  for (const c of stock.unknown) rows.push(['Unknown barcode', c, '', '']);
  return rows;
}
function renderStock() {
  if (!stock) return $('stockResult').replaceChildren();
  const missing = [...stock.expected.values()].filter(x => !stock.found.has(x.id));
  const list = (title, arr, cls) => arr.length ? `<h4>${title} (${arr.length})</h4><table class="inventory-data-table"><thead><tr><th>Barcode</th><th>Container</th><th>Listed location</th></tr></thead><tbody>${arr.map(x => `<tr class="${cls}"><td>${esc(x.barcode)}</td><td>${esc(x.chemical?.name)}</td><td>${esc(x.location_name)}</td></tr>`).join('')}</tbody></table>` : '';
  $('stockResult').innerHTML = `<p><strong>${stock.found.size}</strong> of ${stock.expected.size} found &middot; <strong>${missing.length}</strong> missing &middot; <strong>${stock.unexpected.size}</strong> unexpected &middot; <strong>${stock.unknown.length}</strong> unknown</p>` +
    list('Missing', missing, 'is-locked') + list('Unexpected here', [...stock.unexpected.values()], '') +
    (stock.unknown.length ? `<h4>Unknown barcodes (${stock.unknown.length})</h4><p>${stock.unknown.map(esc).join(', ')}</p>` : '');
  show($('stockMove'), isManager() && stock.unexpected.size > 0);
}
$('stockExport').addEventListener('click', () => { if (!stock) return status('Choose a location first.', 'stockStatus'); downloadCSV('stocktake-' + new Date().toISOString().slice(0, 10) + '.csv', [['Result', 'Barcode', 'Container', 'Listed location'], ...stockReport()]); });
$('stockReset').addEventListener('click', resetStock);
$('stockMove').addEventListener('click', async () => {
  if (!stock?.unexpected.size) return;
  if (!confirm(`Move ${stock.unexpected.size} container(s) to ${locationPath(stock.loc)}?`)) return;
  let ok = 0;
  for (const x of stock.unexpected.values()) {
    const { error } = await db.rpc('inventory_container_action_phase3', { p_id: x.id, p_action: 'move', p: { location_id: stock.loc.id } });
    if (!error) { ok++; x.location_id = stock.loc.id; stock.expected.set(x.id, x); stock.found.add(x.id); stock.unexpected.delete(x.id); }
  }
  renderStock(); status(`Moved ${ok} container(s).`, 'stockStatus');
});

/* Account drawer: the initials circle at the top right opens a panel from the right with account details and Sign Out. */
function setAccountDrawer(open) {
  const drawer = $('accountDrawer'), backdrop = $('accountBackdrop'), btn = $('accountButton');
  if (!drawer) return;
  drawer.classList.toggle('open', open); drawer.setAttribute('aria-hidden', String(!open));
  backdrop.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('ci-drawer-open', open);
  if (open) $('accountClose').focus(); else if (drawer.contains(document.activeElement)) btn.focus();
}
function closeAccountDrawer() { setAccountDrawer(false); }
$('accountButton')?.addEventListener('click', () => setAccountDrawer(!$('accountDrawer').classList.contains('open')));
$('accountClose')?.addEventListener('click', closeAccountDrawer);
$('accountBackdrop')?.addEventListener('click', closeAccountDrawer);
document.addEventListener('keydown', e => {
  const drawer = $('accountDrawer'); if (!drawer?.classList.contains('open')) return;
  if (e.key === 'Escape') return closeAccountDrawer();
  if (e.key !== 'Tab') return;
  const items = [...drawer.querySelectorAll('button, select')].filter(x => x.offsetParent !== null && !x.disabled);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
document.querySelectorAll('[data-sponsor-link]').forEach(a => a.addEventListener('click', e => { if (a.getAttribute('href') === '#') e.preventDefault(); }));
/* mobile helper: copy each header label onto its cells so tables can stack as cards on phones */
(function labelTables() {
  let queued = false;
  const run = () => {
    queued = false;
    document.querySelectorAll('table.inventory-data-table').forEach(t => {
      const heads = [...t.querySelectorAll('thead th')].map(h => h.textContent.trim());
      if (!heads.length) return;
      t.setAttribute('data-cards', '');
      t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => {
        if (td.tagName !== 'TD' || td.hasAttribute('data-label')) return;
        td.setAttribute('data-label', heads[i] || '');
        if (!td.hasAttribute('colspan') && td.childNodes.length > 1) {
          const wrap = document.createElement('span'); wrap.className = 'cell-v';
          while (td.firstChild) wrap.appendChild(td.firstChild);
          td.appendChild(wrap);
        }
      }));
    });
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
  queue();
})();
initSession().catch(e => { showLoggedOut(); status(errorText(e), 'loginError'); });
})();
