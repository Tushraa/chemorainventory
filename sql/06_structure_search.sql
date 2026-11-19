-- Substructure and similarity search: stores each chemical's SMILES (looked up once from PubChem by the app)
-- so the search runs inside the browser with the RDKit chemistry engine.
-- Safe to run more than once. Run after 01..05.

begin;

alter table public.inventory_chemicals add column if not exists smiles text;

-- Saving a looked-up structure is not a user edit: keep it out of Activity History.
create or replace function public.inventory_log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_desc text;
  v_name text;
  v_loc text;
begin
  r := case when tg_op = 'DELETE' then old else new end;

  if tg_table_name = 'inventory_chemicals' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'smiles' - 'updated_at') = (to_jsonb(old) - 'smiles' - 'updated_at') then
    return null;
  end if;

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

-- Managers save looked-up structures. An empty string means "PubChem has no structure for this chemical".
-- Only fills chemicals that have no structure yet, and only in the current lab.
create or replace function public.inventory_save_smiles(p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab(); v_n int := 0; r record;
begin
  if v_lab is null then raise exception 'No active lab selected' using errcode = '42501'; end if;
  if not public.inventory_is_manager() then raise exception 'Only managers can save structures' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'Send at most 1000 structures at a time' using errcode = '22023';
  end if;
  for r in select (e ->> 'id')::uuid as id, left(coalesce(e ->> 'smiles', ''), 2000) as smiles from jsonb_array_elements(p_items) e loop
    update public.inventory_chemicals set smiles = r.smiles where id = r.id and lab_id = v_lab and smiles is null;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;
revoke all on function public.inventory_save_smiles(jsonb) from public, anon;
grant execute on function public.inventory_save_smiles(jsonb) to authenticated;

commit;
