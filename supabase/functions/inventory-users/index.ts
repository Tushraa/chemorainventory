// Edge function "inventory-users": account management.
//  * A lab administrator manages the accounts of the lab they are currently in. Passwords and e-mail
//    addresses of people who also belong to other labs cannot be changed by a lab administrator.
//  * The platform Inventory Administrator manages every lab and every account (pass labId to pick the lab,
//    and global:true to act on an account regardless of lab) and is the only one who can touch another
//    platform administrator, except that a lab administrator may remove the Inventory Administrator from their own
//    lab (membership only: the account is never locked or deactivated by a lab administrator).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const ROLES = ['member', 'manager', 'admin'];
const BAN = '876000h';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const clean = v => String(v ?? '').trim();

async function must(promise, message) {
  const { data, error } = await promise;
  if (error) fail(500, message || error.message);
  return data;
}

export async function handle(req, admin) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'POST') fail(405, 'Use POST.');
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) fail(401, 'Sign in first.');
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth?.user) fail(401, 'Session expired. Sign in again.');
    const callerId = auth.user.id;

    let body;
    try { body = await req.json(); } catch (_e) { fail(400, 'Invalid request.'); }
    const action = clean(body?.action);

    // The caller must be an administrator of their currently selected, active lab.
    const profile = await must(admin.from('inventory_user_profiles').select('active_lab_id,account_status').eq('user_id', callerId).maybeSingle());
    const platformRows = await must(admin.from('inventory_platform_admins').select('user_id').limit(1000));
    const platformIds = new Set(platformRows.map(r => r.user_id));
    const platform = platformIds.has(callerId);
    // The Inventory Administrator needs no working lab (every lab may be deactivated); everyone else does.
    if (!profile || profile.account_status === 'locked' || (!profile.active_lab_id && !platform)) fail(403, 'No active lab for this account.');
    const labId = platform && clean(body.labId) ? clean(body.labId) : profile.active_lab_id;
    if (!labId && !(platform && body.global === true)) fail(403, 'No active lab for this account.');
    if (labId) {
      const lab = await must(admin.from('inventory_labs').select('id,active').eq('id', labId).maybeSingle());
      if (!lab) fail(404, 'Lab not found.');
      if (!lab.active && !platform) fail(403, 'This lab is not active.');
      const mine = await must(admin.from('inventory_members').select('role').eq('lab_id', labId).eq('user_id', callerId).maybeSingle());
      if (mine?.role !== 'admin' && !platform) fail(403, 'Only lab administrators can manage accounts.');
    }
    const globalScope = platform && body.global === true;
    const guardPlatformTarget = (id, allowRemoval = false) => { if (allowRemoval) return; if (platformIds.has(id) && !platform) fail(403, 'Only the Inventory Administrator can change that account.'); };

    const members = async () => await must(admin.from('inventory_members').select('user_id,role').eq('lab_id', labId).limit(5000));
    const requireTarget = async (allowPlatformRemoval = false) => {
      const id = clean(body.userId);
      if (!id) fail(400, 'userId is required.');
      guardPlatformTarget(id, allowPlatformRemoval);
      if (globalScope) {
        const prof = await must(admin.from('inventory_user_profiles').select('user_id').eq('user_id', id).maybeSingle());
        if (!prof) fail(404, 'Account not found.');
        return { user_id: id, role: 'member' };
      }
      const row = (await members()).find(m => m.user_id === id);
      if (!row) fail(404, 'That person is not in this lab.');
      return row;
    };
    const otherLabs = async id => (await must(admin.from('inventory_members').select('lab_id').eq('user_id', id).neq('lab_id', labId).limit(1))).length;
    const adminCountAfter = async (id, newRole) => (await members()).filter(m => (m.user_id === id ? newRole : m.role) === 'admin').length;

    if (action === 'list') {
      const rows = await members();
      const ids = rows.map(r => r.user_id);
      const profiles = ids.length ? await must(admin.from('inventory_user_profiles').select('user_id,full_name,email,account_status').in('user_id', ids).limit(5000)) : [];
      const byId = new Map(profiles.map(p => [p.user_id, p]));
      return json(200, { users: rows.map(r => { const p = byId.get(r.user_id) || {}; return { user_id: r.user_id, platform_admin: platformIds.has(r.user_id), id: r.user_id, full_name: p.full_name || '', name: p.full_name || '', email: p.email || '', account_status: p.account_status || 'active', role: r.role }; }) });
    }

    if (action === 'create') {
      const name = clean(body.name), email = clean(body.email).toLowerCase(), role = clean(body.role) || 'member', password = String(body.password ?? '');
      if (!name) fail(400, 'Full name is required.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid e-mail address.');
      if (!ROLES.includes(role)) fail(400, 'Invalid role.');
      const found = (await must(admin.from('inventory_user_profiles').select('user_id,email').ilike('email', email).limit(50))).find(p => clean(p.email).toLowerCase() === email);
      if (found) {
        if ((await members()).some(m => m.user_id === found.user_id)) fail(409, 'That person is already a member of this lab.');
        await must(admin.from('inventory_members').insert({ lab_id: labId, user_id: found.user_id, role }));
        return json(200, { ok: true, existing: true, userId: found.user_id });
      }
      if (password.length < 12) fail(400, 'Password must contain at least 12 characters.');
      const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
      if (createError || !created?.user) fail(400, createError?.message || 'Could not create the account.');
      const id = created.user.id;
      await must(admin.from('inventory_user_profiles').upsert({ user_id: id, full_name: name, email }, { onConflict: 'user_id' }));
      await must(admin.from('inventory_members').upsert({ lab_id: labId, user_id: id, role }, { onConflict: 'lab_id,user_id' }));
      await must(admin.from('inventory_user_profiles').update({ active_lab_id: labId }).eq('user_id', id).is('active_lab_id', null));
      return json(200, { ok: true, userId: id });
    }

    if (action === 'update') {
      const target = await requireTarget();
      const id = target.user_id, shared = !platform && await otherLabs(id) > 0;
      const name = clean(body.name), email = clean(body.email).toLowerCase(), role = clean(body.role), password = String(body.password ?? '');
      if (role && !globalScope) {
        if (!ROLES.includes(role)) fail(400, 'Invalid role.');
        if (role !== target.role) {
          if (id === callerId && role !== 'admin') fail(400, 'You cannot remove your own administrator access.');
          if (await adminCountAfter(id, role) < 1) fail(400, 'A lab needs at least one administrator.');
          await must(admin.from('inventory_members').update({ role }).eq('lab_id', labId).eq('user_id', id));
        }
      }
      if (name) {
        await must(admin.from('inventory_user_profiles').update({ full_name: name }).eq('user_id', id));
        await admin.auth.admin.updateUserById(id, { user_metadata: { full_name: name } });
      }
      if (email || password) {
        if (shared) fail(403, 'This person also belongs to another lab, so their e-mail and password can only be changed by themselves.');
        const attrs = {};
        if (email) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid e-mail address.');
          attrs.email = email; attrs.email_confirm = true;
        }
        if (password) {
          if (password.length < 12) fail(400, 'Password must contain at least 12 characters.');
          attrs.password = password;
        }
        const { error } = await admin.auth.admin.updateUserById(id, attrs);
        if (error) fail(400, error.message);
        if (email) await must(admin.from('inventory_user_profiles').update({ email }).eq('user_id', id));
      }
      return json(200, { ok: true });
    }

    if (action === 'lock' || action === 'unlock') {
      const target = await requireTarget();
      if (target.user_id === callerId) fail(400, 'You cannot lock your own account.');
      if (!platform && await otherLabs(target.user_id) > 0) fail(403, 'This person also belongs to another lab. Remove them from this lab instead of locking the account.');
      const locking = action === 'lock';
      const { error } = await admin.auth.admin.updateUserById(target.user_id, { ban_duration: locking ? BAN : 'none' });
      if (error) fail(400, error.message);
      await must(admin.from('inventory_user_profiles').update({ account_status: locking ? 'locked' : 'active' }).eq('user_id', target.user_id));
      return json(200, { ok: true });
    }

    if (action === 'delete' && globalScope) {
      // Inventory Administrator: remove the account from every lab and deactivate it (records and history are kept).
      const target = await requireTarget();
      const id = target.user_id;
      if (id === callerId) fail(400, 'You cannot remove yourself.');
      await must(admin.from('inventory_members').delete().eq('user_id', id));
      await admin.auth.admin.updateUserById(id, { ban_duration: BAN });
      await must(admin.from('inventory_user_profiles').update({ account_status: 'locked', active_lab_id: null }).eq('user_id', id));
      return json(200, { ok: true });
    }

    if (action === 'delete') {
      const target = await requireTarget(true);
      const id = target.user_id;
      if (id === callerId) fail(400, 'You cannot remove yourself.');
      if (target.role === 'admin' && await adminCountAfter(id, 'none') < 1) fail(400, 'A lab needs at least one administrator.');
      await must(admin.from('inventory_members').delete().eq('lab_id', labId).eq('user_id', id));
      if (platformIds.has(id)) return json(200, { ok: true, removedFromLab: true }); // the Inventory Administrator keeps platform-wide access
      const remaining = await must(admin.from('inventory_members').select('lab_id').eq('user_id', id).limit(1));
      if (remaining.length) {
        await must(admin.from('inventory_user_profiles').update({ active_lab_id: remaining[0].lab_id }).eq('user_id', id).eq('active_lab_id', labId));
      } else {
        // Deactivate rather than delete so the containers and history they own are kept.
        await admin.auth.admin.updateUserById(id, { ban_duration: BAN });
        await must(admin.from('inventory_user_profiles').update({ account_status: 'locked', active_lab_id: null }).eq('user_id', id));
      }
      return json(200, { ok: true });
    }

    fail(400, 'Unknown action.');
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'Unexpected error.' });
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  let serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) { try { serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default; } catch (_e) { /* no secret key available */ } }
  const admin = createClient(Deno.env.get('SUPABASE_URL'), serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  Deno.serve(req => handle(req, admin));
}
