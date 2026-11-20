// Edge function "inventory-notify": e-mails about order activity, sent through Resend.
//  * The app calls it right after an order is requested, marked as ordered, received or cancelled.
//  * Lab recipients (Order Settings) get every event. The person who made the request also gets the
//    ordered / received / cancelled updates (unless they did that action themselves).
//  * The function re-reads the order from the database and only sends when the order really is in the
//    state the caller claims, and only once per event, so the endpoint cannot be used to spam anyone.
//  * event "test" sends a sample message to the caller's own address (managers only) to check the setup.
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   RESEND_API_KEY  required. MAIL_FROM optional, e.g. "Chemora Inventory <noreply@chemora.art>".
//   SITE_URL        optional link used inside the e-mails (default https://app.chemora.art/).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const EVENTS = ['requested', 'ordered', 'received', 'cancelled'];
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const clean = v => String(v ?? '').trim();
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function must(promise, message) {
  const { data, error } = await promise;
  if (error) fail(500, message || error.message);
  return data;
}

const HEADLINES = {
  requested: 'New order request',
  ordered: 'Order placed',
  received: 'Order received',
  cancelled: 'Order request cancelled',
  test: 'Test message'
};

export function buildMessage(event, order, labName, actorName, siteUrl) {
  const head = HEADLINES[event];
  const what = `${order.chemical_name} (${order.container_size} ${order.unit})`;
  const subject = event === 'test' ? '[Chemora] Test message' : `[Chemora] ${head}: ${what}`;
  const rows = event === 'test' ? [] : [
    ['Chemical', order.chemical_name], ['CAS Number', order.cas || '—'], ['Size', `${order.container_size} ${order.unit}`],
    ['Supplier', order.supplier || '—'], ['Comments', order.comments || '—'], ['Laboratory', labName || '—'], ['Status', order.status],
    ['Last action by', actorName || '—']
  ];
  const intro = event === 'test'
    ? 'This is a test message from Chemora Inventory. If you can read it, order e-mails are working.'
    : { requested: 'A new order request was submitted.', ordered: 'This order request was marked as ordered.', received: 'This order was received and added to the inventory.', cancelled: 'This order request was cancelled.' }[event];
  const text = [head, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Open Chemora Inventory: ${siteUrl}`].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
<div style="background:#0f1b2d;color:#fff;padding:16px 20px;border-radius:6px 6px 0 0"><strong style="font-size:18px">Chemora</strong> <span style="letter-spacing:2px;font-size:11px;color:#2dd4bf">INVENTORY</span></div>
<div style="border:1px solid #d6dde6;border-top:0;padding:20px;border-radius:0 0 6px 6px">
<h2 style="margin:0 0 8px;font-size:18px">${esc(head)}</h2><p style="margin:0 0 16px">${esc(intro)}</p>
${rows.length ? `<table style="border-collapse:collapse;width:100%;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:6px 10px;border:1px solid #e3e8ef;background:#f6f8fb;width:36%"><strong>${esc(k)}</strong></td><td style="padding:6px 10px;border:1px solid #e3e8ef">${esc(v)}</td></tr>`).join('')}</table>` : ''}
<p style="margin:20px 0 0"><a href="${esc(siteUrl)}" style="background:#12a58a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:4px;display:inline-block">Open Chemora Inventory</a></p>
</div><p style="font-size:12px;color:#6b7280;text-align:center">Sent by Chemora Inventory. Lab managers can change who receives order e-mails in Order Settings.</p></div>`;
  return { subject, text, html };
}

// Sends every message in one Resend batch call (Resend allows only 2 requests per second on small plans).
export async function sendWithResend(messages, env = (k => Deno.env.get(k)), fetchImpl = fetch) {
  const key = env('RESEND_API_KEY');
  if (!key) fail(500, 'E-mail is not set up yet: RESEND_API_KEY is missing.');
  const from = env('MAIL_FROM') || 'Chemora Inventory <noreply@chemora.art>';
  const r = await fetchImpl('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(messages.map(m => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text })))
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('Resend error', r.status, detail);
    fail(502, r.status === 403 || r.status === 422 ? 'The e-mail service rejected the message. Check that the sender domain is verified in Resend.' : 'The e-mail service could not send the message.');
  }
}

export async function handle(req, admin, send = sendWithResend, siteUrl = 'https://app.chemora.art/') {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'POST') fail(405, 'Use POST.');
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) fail(401, 'Sign in first.');
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth?.user) fail(401, 'Session expired. Sign in again.');
    const caller = auth.user;

    let body;
    try { body = await req.json(); } catch (_e) { fail(400, 'Invalid request.'); }
    const event = clean(body?.event);
    if (event !== 'test' && !EVENTS.includes(event)) fail(400, 'Unknown event.');

    const profile = await must(admin.from('inventory_user_profiles').select('full_name,email,account_status,active_lab_id').eq('user_id', caller.id).maybeSingle());
    if (!profile || profile.account_status === 'locked') fail(403, 'This account cannot send notifications.');
    const callerName = clean(profile.full_name) || clean(caller.email);
    const callerEmail = clean(profile.email || caller.email).toLowerCase();

    if (event === 'test') {
      const mine = profile.active_lab_id ? await must(admin.from('inventory_members').select('role').eq('lab_id', profile.active_lab_id).eq('user_id', caller.id).maybeSingle()) : null;
      if (!mine || !['manager', 'admin'].includes(mine.role)) fail(403, 'Only chemical managers can send a test message.');
      if (!EMAIL.test(callerEmail)) fail(400, 'Your account has no e-mail address.');
      const m = buildMessage('test', {}, '', callerName, siteUrl);
      await send([{ to: callerEmail, ...m }]);
      return json(200, { sent: 1 });
    }

    const orderId = clean(body?.order_id);
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) fail(400, 'order_id is required.');
    const order = await must(admin.from('inventory_orders').select('*').eq('id', orderId).maybeSingle());
    if (!order) fail(404, 'Order not found.');

    // The caller must belong to the order's lab (the Inventory Administrator may act in any lab).
    const platform = (await must(admin.from('inventory_platform_admins').select('user_id').eq('user_id', caller.id).limit(1))).length > 0;
    if (!platform) {
      const member = await must(admin.from('inventory_members').select('role').eq('lab_id', order.lab_id).eq('user_id', caller.id).maybeSingle());
      if (!member) fail(403, 'You are not a member of that laboratory.');
    }
    // Only announce what really happened: the order must be in the state the caller names.
    if (order.status !== event) return json(200, { sent: 0, skipped: 'Order is not in that state.' });
    const stamp = event === 'requested' ? order.requested_at : event === 'ordered' ? order.ordered_at : event === 'received' ? order.received_at : 'cancelled';
    if (!stamp) return json(200, { sent: 0, skipped: 'Order is not in that state.' });

    const lab = await must(admin.from('inventory_labs').select('name,active').eq('id', order.lab_id).maybeSingle());
    if (!lab?.active) return json(200, { sent: 0, skipped: 'Laboratory is not active.' });

    const recipients = new Set((await must(admin.from('inventory_order_recipients').select('email').eq('lab_id', order.lab_id).limit(100))).map(r => r.email));
    if (event !== 'requested' && order.requested_by && order.requested_by !== caller.id) {
      const rp = await must(admin.from('inventory_user_profiles').select('email,account_status').eq('user_id', order.requested_by).maybeSingle());
      let to = clean(rp?.email).toLowerCase();
      if (!to) { const { data: u } = await admin.auth.admin.getUserById(order.requested_by); to = clean(u?.user?.email).toLowerCase(); }
      if (rp?.account_status !== 'locked' && EMAIL.test(to)) recipients.add(to);
    }
    const list = [...recipients].filter(e => EMAIL.test(e));
    if (!list.length) return json(200, { sent: 0, skipped: 'No recipients.' });

    // Claim this event first; a repeated call finds the row and does nothing.
    const { error: claimError } = await admin.from('inventory_order_notifications').insert({ order_id: order.id, event, stamp: String(stamp) });
    if (claimError) {
      if (claimError.code === '23505') return json(200, { sent: 0, skipped: 'Already sent.' });
      fail(500, claimError.message);
    }
    const m = buildMessage(event, order, lab.name, callerName, siteUrl);
    try { await send(list.map(to => ({ to, ...m }))); }
    catch (err) {
      // Release the claim so a later attempt can try again.
      await admin.from('inventory_order_notifications').delete().eq('order_id', order.id).eq('event', event).eq('stamp', String(stamp));
      throw err;
    }
    return json(200, { sent: list.length });
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
  const siteUrl = Deno.env.get('SITE_URL') || 'https://app.chemora.art/';
  Deno.serve(req => handle(req, admin, undefined, siteUrl));
}
