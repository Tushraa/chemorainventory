// Edge function "inventory-users": account management.
//  * A lab administrator manages the accounts of the lab they are currently in. Passwords and e-mail
//    addresses of people who also belong to other labs cannot be changed by a lab administrator.
//  * action 'purge' (Inventory Administrator only) permanently deletes an account that belongs to no lab.
//  * The Inventory Administrator can never be a member of a lab, and a lab always keeps at least one administrator.
//  * The platform Inventory Administrator manages every lab and every account (pass labId to pick the lab,
//    and global:true to act on an account regardless of lab) and is the only one who can touch another
//  * When a lab administrator adds someone, an optional welcome e-mail (Resend) carries the sign-in link and the
//    person's e-mail address. With no password given, a random one is set that nobody sees and the person chooses
//    their own through "Forgot Password?". Secrets: RESEND_API_KEY, optional MAIL_FROM and SITE_URL.
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
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE_LABELS = { member: 'Member', manager: 'Chemical Manager', admin: 'Administrator' };
// A password nobody sees: used when the administrator leaves the field empty, so the person must pick their own.
const randomPassword = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, 'x') + 'Aa1!';

export function buildWelcomeMessage({ name, email, labName, role, adminName, existing, siteUrl }) {
  const roleLabel = ROLE_LABELS[role] || 'Member';
  const subject = `[Chemora] You have been added to ${labName || 'a laboratory'}`;
  const first = existing
    ? 'Sign in with your existing Chemora password. If you have forgotten it, choose "Forgot Password?" on the sign-in page.'
    : 'This is your first sign-in, so you need to choose a password: open the sign-in page, enter the email address above, choose "Forgot Password?" and follow the link that is emailed to you.';
  const text = [`Hello ${name || ''},`, '', `${adminName || 'A lab administrator'} added you to ${labName || 'a laboratory'} on Chemora Inventory as ${roleLabel}.`, '',
    `Sign-in page: ${siteUrl}`, `Your email address: ${email}`, '', first, '', 'Nobody has shared a password with you, and nobody else knows your password once you choose it.'].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
<div style="background:#0f1b2d;color:#fff;padding:16px 20px;border-radius:6px 6px 0 0"><strong style="font-size:18px">Chemora</strong> <span style="letter-spacing:2px;font-size:11px;color:#2dd4bf">INVENTORY</span></div>
<div style="border:1px solid #d6dde6;border-top:0;padding:20px;border-radius:0 0 6px 6px">
<h2 style="margin:0 0 8px;font-size:18px">Welcome${name ? ', ' + esc(name) : ''}</h2>
<p style="margin:0 0 12px">${esc(adminName || 'A lab administrator')} added you to <strong>${esc(labName || 'a laboratory')}</strong> on Chemora Inventory as <strong>${esc(roleLabel)}</strong>.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><tr><td style="padding:6px 10px;border:1px solid #e3e8ef;background:#f6f8fb;width:36%"><strong>Your email address</strong></td><td style="padding:6px 10px;border:1px solid #e3e8ef">${esc(email)}</td></tr></table>
<p style="margin:16px 0">${esc(first)}</p>
<p style="margin:20px 0 0"><a href="${esc(siteUrl)}" style="background:#12a58a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:4px;display:inline-block">Open the sign-in page</a></p>
</div><p style="font-size:12px;color:#6b7280;text-align:center">No password was shared with you. You choose your own.</p></div>`;
  return { subject, text, html };
}

export async function sendWithResend(message, env = (k => Deno.env.get(k)), fetchImpl = fetch) {
  const key = env('RESEND_API_KEY');
  if (!key) fail(500, 'E-mail is not set up yet (RESEND_API_KEY is missing).');
  const from = env('MAIL_FROM') || 'Chemora Inventory <noreply@chemora.art>';
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text })
  });
  if (!r.ok) {
    console.error('Resend error', r.status, await r.text().catch(() => ''));
    fail(502, r.status === 403 || r.status === 422 ? 'The e-mail service rejected the message. Check that the sender domain is verified in Resend.' : 'The e-mail service could not send the message.');
  }
}

async function must(promise, message) {
  const { data, error } = await promise;
  if (error) fail(500, message || error.message);
  return data;
}

export async function handle(req, admin, send = sendWithResend, siteUrl = 'https://app.chemora.art/') {
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
    // The Inventory Administrator never counts as a lab administrator.
    const adminCountAfter = async (id, newRole) => (await members()).filter(m => !platformIds.has(m.user_id) && (m.user_id === id ? newRole : m.role) === 'admin').length;

    if (action === 'list') {
      const rows = await members();
      const ids = rows.map(r => r.user_id);
      const profiles = ids.length ? await must(admin.from('inventory_user_profiles').select('user_id,full_name,email,account_status').in('user_id', ids).limit(5000)) : [];
      const byId = new Map(profiles.map(p => [p.user_id, p]));
      return json(200, { users: rows.map(r => { const p = byId.get(r.user_id) || {}; return { user_id: r.user_id, platform_admin: platformIds.has(r.user_id), id: r.user_id, full_name: p.full_name || '', name: p.full_name || '', email: p.email || '', account_status: p.account_status || 'active', role: r.role }; }) });
    }

    if (action === 'create') {
      const name = clean(body.name), email = clean(body.email).toLowerCase(), role = clean(body.role) || 'member', password = String(body.password ?? '');
      const welcome = body.welcome === true;
      if (!name) fail(400, 'Full name is required.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid e-mail address.');
      if (!ROLES.includes(role)) fail(400, 'Invalid role.');
      // The welcome e-mail never fails the creation: the result tells the page whether it went out.
      const welcomeResult = async (displayName, existing) => {
        if (!welcome) return {};
        try {
          const lab = await must(admin.from('inventory_labs').select('name').eq('id', labId).maybeSingle());
          const me = await must(admin.from('inventory_user_profiles').select('full_name').eq('user_id', callerId).maybeSingle());
          await send({ to: email, ...buildWelcomeMessage({ name: displayName, email, labName: lab?.name, role, adminName: clean(me?.full_name), existing, siteUrl }) });
          return { emailSent: true };
        } catch (err) {
          console.error('Welcome e-mail failed:', err?.message);
          return { emailSent: false, emailError: err instanceof HttpError ? err.message : 'The welcome e-mail could not be sent.' };
        }
      };
      const found = (await must(admin.from('inventory_user_profiles').select('user_id,email,full_name').ilike('email', email).limit(50))).find(p => clean(p.email).toLowerCase() === email);
      if (found) {
        if (platformIds.has(found.user_id)) fail(400, 'The Inventory Administrator cannot be added to a lab.');
        if ((await members()).some(m => m.user_id === found.user_id)) fail(409, 'That person is already a member of this lab.');
        await must(admin.from('inventory_members').insert({ lab_id: labId, user_id: found.user_id, role }));
        return json(200, { ok: true, existing: true, userId: found.user_id, ...(await welcomeResult(clean(found.full_name) || name, true)) });
      }
      if (password && password.length < 12) fail(400, 'Password must contain at least 12 characters.');
      const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password: password || randomPassword(), email_confirm: true, user_metadata: { full_name: name } });
      if (createError || !created?.user) fail(400, createError?.message || 'Could not create the account.');
      const id = created.user.id;
      await must(admin.from('inventory_user_profiles').upsert({ user_id: id, full_name: name, email }, { onConflict: 'user_id' }));
      await must(admin.from('inventory_members').upsert({ lab_id: labId, user_id: id, role }, { onConflict: 'lab_id,user_id' }));
      await must(admin.from('inventory_user_profiles').update({ active_lab_id: labId }).eq('user_id', id).is('active_lab_id', null));
      return json(200, { ok: true, userId: id, passwordSet: !!password, ...(await welcomeResult(name, false)) });
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

    if (action === 'purge') {
      // Inventory Administrator only: permanently delete an account that belongs to no lab.
      if (!platform) fail(403, 'Only the Inventory Administrator can permanently delete accounts.');
      const id = clean(body.userId);
      if (!id) fail(400, 'userId is required.');
      if (id === callerId) fail(400, 'You cannot delete yourself.');
      if (platformIds.has(id)) fail(403, 'The Inventory Administrator account cannot be deleted.');
      const prof = await must(admin.from('inventory_user_profiles').select('user_id,email').eq('user_id', id).maybeSingle());
      if (!prof) fail(404, 'Account not found.');
      const inLabs = await must(admin.from('inventory_members').select('lab_id').eq('user_id', id).limit(1));
      if (inLabs.length) fail(400, 'This account still belongs to a lab. Remove it from every lab first.');
      if (prof.email) await must(admin.from('inventory_pending_members').delete().ilike('email', prof.email));
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) fail(400, error.message);
      await must(admin.from('inventory_user_profiles').delete().eq('user_id', id));
      return json(200, { ok: true });
    }

    if (action === 'delete' && globalScope) {
      // Inventory Administrator: remove the account from every lab and deactivate it (records and history are kept).
      const target = await requireTarget();
      const id = target.user_id;
      if (id === callerId) fail(400, 'You cannot remove yourself.');
      // Never leave a lab without an administrator.
      const adminLabs = await must(admin.from('inventory_members').select('lab_id').eq('user_id', id).eq('role', 'admin').limit(1000));
      for (const row of adminLabs) {
        const others = (await must(admin.from('inventory_members').select('user_id').eq('lab_id', row.lab_id).eq('role', 'admin').neq('user_id', id).limit(1000))).filter(m => !platformIds.has(m.user_id));
        if (!others.length) {
          const lab = await must(admin.from('inventory_labs').select('name').eq('id', row.lab_id).maybeSingle());
          fail(400, `This person is the only administrator of ${lab?.name || 'a lab'}. Assign another administrator to that lab first.`);
        }
      }
      await must(admin.from('inventory_members').delete().eq('user_id', id));
      await admin.auth.admin.updateUserById(id, { ban_duration: BAN });
      await must(admin.from('inventory_user_profiles').update({ account_status: 'locked', active_lab_id: null }).eq('user_id', id));
      return json(200, { ok: true });
    }

    if (action === 'delete') {
      const target = await requireTarget(true);
      const id = target.user_id;
      if (id === callerId) fail(400, 'You cannot remove yourself.');
      if (target.role === 'admin' && !platformIds.has(id) && await adminCountAfter(id, 'none') < 1) fail(400, 'A lab needs at least one administrator. Assign another administrator first.');
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
  Deno.serve(req => handle(req, admin, undefined, Deno.env.get('SITE_URL') || 'https://app.chemora.art/'));
}
