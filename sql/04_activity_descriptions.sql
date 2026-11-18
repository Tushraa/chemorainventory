-- Adds a readable description to every activity-log row, so Activity History & Auditing can show
-- e.g. "Ethanol (HG-000012) added to database" or "Ethanol (HG-000012) moved to Main / Room 1".
-- Safe to run more than once. Existing rows keep an empty description (the app builds a fallback).

alter table public.inventory_activity_logs add column if not exists description text;

create or replace function public.inventory_log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_desc text;
  v_name text;
  v_loc text;
begin
  r := case when tg_op = 'DELETE' then old else new end;

  if tg_table_name = 'inventory_containers' then
    select c.name into v_name from public.inventory_chemicals c where c.lab_id = r.lab_id and c.id = r.chemical_id;
    v_name := coalesce(v_name, 'Container') || ' (' || coalesce(r.barcode, '?') || ')';
    if tg_op = 'INSERT' then
      v_desc := v_name || ' added to database';
    elsif tg_op = 'DELETE' then
      v_desc := v_name || ' deleted';
    elsif new.location_id is distinct from old.location_id then
      select l.name into v_loc from public.inventory_locations l where l.lab_id = new.lab_id and l.id = new.location_id;
      v_desc := v_name || ' moved to ' || coalesce(v_loc, 'another location');
    elsif new.owner_id is distinct from old.owner_id then
      v_desc := v_name || ' ownership transferred';
    elsif new.status is distinct from old.status then
      v_desc := v_name || ' marked ' || new.status;
    elsif new.remaining_amount is distinct from old.remaining_amount then
      v_desc := v_name || ' quantity changed to ' || coalesce(new.remaining_amount::text, 'unknown') || ' ' || new.unit;
    else
      v_desc := v_name || ' details edited';
    end if;
  elsif tg_table_name = 'inventory_chemicals' then
    v_name := coalesce(r.name, 'Chemical');
    v_desc := v_name || case tg_op when 'INSERT' then ' added to database' when 'DELETE' then ' deleted' else ' details edited' end;
  elsif tg_table_name = 'inventory_locations' then
    v_name := coalesce(r.name, 'Location');
    v_desc := 'Location ' || v_name || case tg_op when 'INSERT' then ' created' when 'DELETE' then ' deleted' else ' edited' end;
  elsif tg_table_name = 'inventory_orders' then
    v_name := coalesce(r.chemical_name, 'Order');
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      v_desc := 'Order for ' || v_name || ' is now ' || new.status;
    else
      v_desc := 'Order for ' || v_name || case tg_op when 'INSERT' then ' requested' when 'DELETE' then ' deleted' else ' edited' end;
    end if;
  else
    v_desc := tg_table_name || ' ' || lower(tg_op);
  end if;

  insert into public.inventory_activity_logs (lab_id, table_name, record_id, action, performed_by, description)
  values (r.lab_id, tg_table_name, r.id, lower(tg_op), auth.uid(), v_desc);
  return null;
end $$;
