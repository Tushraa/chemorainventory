-- Order rules: the requester may edit their own request until it is marked as ordered, and the app records
-- who cancelled an order so that only a cancellation by a manager/administrator e-mails the requester.
-- Run once in the Supabase SQL editor. Safe to run again.

-- 1. Who cancelled the order ------------------------------------------------------------------------------------
alter table public.inventory_orders add column if not exists cancelled_by uuid references auth.users (id) on delete set null;

-- 2. Cancel/ordered/undo/receive: same as before, but "cancel" remembers who did it -------------------------------
create or replace function public.inventory_order_action_phase4(p_order_id uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab(); o public.inventory_orders; v_res jsonb; v_cid uuid;
begin
  if v_lab is null then raise exception 'No active lab selected' using errcode = '42501'; end if;
  select * into o from public.inventory_orders where id = p_order_id and lab_id = v_lab for update;
  if not found then raise exception 'Order not found' using errcode = '22023'; end if;

  if p_action = 'cancel' then
    if not (public.inventory_is_manager() or (o.requested_by = auth.uid() and o.status = 'requested')) then
      raise exception 'You cannot cancel this order' using errcode = '42501';
    end if;
    if o.status not in ('requested', 'ordered') then raise exception 'This order can no longer be cancelled' using errcode = '22023'; end if;
    update public.inventory_orders set status = 'cancelled', cancelled_by = auth.uid() where id = o.id;
  else
    if not public.inventory_is_manager() then raise exception 'Only managers can update orders' using errcode = '42501'; end if;
    if p_action = 'ordered' then
      if o.status <> 'requested' then raise exception 'Only requested orders can be marked as ordered' using errcode = '22023'; end if;
      update public.inventory_orders set status = 'ordered', ordered_at = now() where id = o.id;
    elsif p_action = 'undo' then
      if o.status <> 'ordered' then raise exception 'Only ordered orders can be reverted' using errcode = '22023'; end if;
      update public.inventory_orders set status = 'requested', ordered_at = null where id = o.id;
    elsif p_action = 'receive' then
      if o.status not in ('requested', 'ordered') then raise exception 'This order cannot be received' using errcode = '22023'; end if;
      v_res := public.inventory_register_container_phase3(jsonb_build_object(
        'name', o.chemical_name, 'cas', o.cas, 'container_size', o.container_size, 'unit', o.unit,
        'supplier', coalesce(nullif(p ->> 'supplier', ''), o.supplier),
        'location_id', p ->> 'location_id', 'owner_id', p ->> 'owner_id',
        'received_at', p ->> 'received_at', 'expires_at', p ->> 'expires_at', 'remaining_amount', p ->> 'remaining_amount',
        'catalog_number', p ->> 'catalog_number', 'lot_number', p ->> 'lot_number', 'purity', p ->> 'purity', 'notes', p ->> 'notes'));
      v_cid := (v_res ->> 'container_id')::uuid;
      update public.inventory_orders set status = 'received', received_at = now(), received_container_id = v_cid where id = o.id;
      return v_res;
    else
      raise exception 'Unknown action %', p_action using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object('id', o.id, 'action', p_action);
end $$;

-- 3. Edit a request: managers, or the person who made the request, while it is still "requested" ---------------------
create or replace function public.inventory_edit_order_phase5(p_order_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab(); o public.inventory_orders;
begin
  if v_lab is null then raise exception 'No active lab selected' using errcode = '42501'; end if;
  select * into o from public.inventory_orders where id = p_order_id and lab_id = v_lab for update;
  if not found then raise exception 'Order not found' using errcode = '22023'; end if;
  if not (public.inventory_is_manager() or o.requested_by = auth.uid()) then
    raise exception 'Only the requester or a manager can edit this request' using errcode = '42501';
  end if;
  if o.status <> 'requested' then raise exception 'Only requested orders can be edited' using errcode = '22023'; end if;
  update public.inventory_orders set
    chemical_name = btrim(p ->> 'chemical_name'),
    cas = nullif(btrim(coalesce(p ->> 'cas', '')), ''),
    container_size = (p ->> 'container_size')::numeric,
    unit = btrim(p ->> 'unit'),
    supplier = nullif(btrim(coalesce(p ->> 'supplier', '')), ''),
    comments = nullif(btrim(coalesce(p ->> 'comments', '')), '')
  where id = o.id;
end $$;

revoke all on function public.inventory_order_action_phase4(uuid, text, jsonb) from public, anon;
grant execute on function public.inventory_order_action_phase4(uuid, text, jsonb) to authenticated;
revoke all on function public.inventory_edit_order_phase5(uuid, jsonb) from public, anon;
grant execute on function public.inventory_edit_order_phase5(uuid, jsonb) to authenticated;
