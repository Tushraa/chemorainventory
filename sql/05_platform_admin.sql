-- Platform "Inventory Administrator" + per-lab administrators, GHS hazard codes, bulk container actions.
--
--  * A platform administrator (the Inventory Administrator) has administrator rights in EVERY lab: can open any lab,
--    create / rename / deactivate labs, appoint lab administrators and see every user.
--  * A lab administrator controls only their own lab (members, locations, import, tools).
--  * Chemicals get GHS hazard codes (H-codes) so containers can be searched by hazard.
--  * Optional pre-printed barcode when registering a container.
--
-- Safe to run more than once. Run after 01..04.

begin;

-- ---------------------------------------------------------------------------
-- 1. A platform administrator may use any active lab as its working lab, as administrator.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_current_lab() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.active_lab_id
  from public.inventory_user_profiles p
  join public.inventory_labs l on l.id = p.active_lab_id and l.active
  where p.user_id = auth.uid() and p.account_status is distinct from 'locked'
    and (exists (select 1 from public.inventory_members m where m.lab_id = p.active_lab_id and m.user_id = p.user_id)
         or exists (select 1 from public.inventory_platform_admins pa where pa.user_id = p.user_id))
$$;

create or replace function public.inventory_role() returns text
language sql stable security definer set search_path = '' as $$
  select case
    when public.inventory_current_lab() is null then null
    when exists (select 1 from public.inventory_platform_admins pa where pa.user_id = auth.uid()) then 'admin'
    else (select m.role from public.inventory_members m where m.user_id = auth.uid() and m.lab_id = public.inventory_current_lab())
  end
$$;

-- ---------------------------------------------------------------------------
-- 2. Context, switching, creating labs
-- ---------------------------------------------------------------------------
create or replace function public.inventory_my_context() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_lab uuid; v_status text; v_platform boolean;
begin
  if v_uid is null then return null; end if;

  insert into public.inventory_user_profiles (user_id, full_name, email)
  select u.id, coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(u.email, '@', 1)), u.email
  from auth.users u where u.id = v_uid
  on conflict (user_id) do nothing;

  v_platform := public.inventory_is_platform_admin();

  update public.inventory_user_profiles p
  set active_lab_id = coalesce(
        (select m.lab_id from public.inventory_members m
           join public.inventory_labs l on l.id = m.lab_id and l.active
           where m.user_id = p.user_id order by m.created_at limit 1),
        case when v_platform then (select l.id from public.inventory_labs l where l.active order by l.created_at limit 1) end)
  where p.user_id = v_uid
    and (p.active_lab_id is null
         or not exists (select 1 from public.inventory_labs l where l.id = p.active_lab_id and l.active)
         or (not v_platform and not exists (select 1 from public.inventory_members m where m.user_id = p.user_id and m.lab_id = p.active_lab_id)));

  v_lab := public.inventory_current_lab();
  select account_status into v_status from public.inventory_user_profiles where user_id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid,
    'account_status', coalesce(v_status, 'active'),
    'lab_id', v_lab,
    'lab_name', (select name from public.inventory_labs where id = v_lab),
    'role', public.inventory_role(),
    'platform_admin', v_platform,
    'labs', case when v_platform then
        coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'role', 'admin') order by l.name)
                  from public.inventory_labs l where l.active), '[]'::jsonb)
      else
        coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'role', m.role) order by l.name)
                  from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id
                  where m.user_id = v_uid and l.active), '[]'::jsonb)
      end);
end $$;
revoke all on function public.inventory_my_context() from public, anon;
grant execute on function public.inventory_my_context() to authenticated;

create or replace function public.inventory_switch_lab(p_lab_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.inventory_labs l where l.id = p_lab_id and l.active)
     or not (public.inventory_is_platform_admin()
             or exists (select 1 from public.inventory_members m where m.user_id = auth.uid() and m.lab_id = p_lab_id)) then
    raise exception 'You are not a member of that lab' using errcode = '42501';
  end if;
  update public.inventory_user_profiles set active_lab_id = p_lab_id where user_id = auth.uid();
  return public.inventory_my_context();
end $$;

-- Platform administrators only. The optional e-mail becomes the new lab's administrator (invited if not yet registered).
drop function if exists public.inventory_create_lab(text, text, text);
create function public.inventory_create_lab(p_name text, p_slug text, p_prefix text default 'CH', p_admin_email text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.inventory_is_platform_admin() then raise exception 'Only the Inventory Administrator can create labs' using errcode = '42501'; end if;
  insert into public.inventory_labs (name, slug, barcode_prefix) values (btrim(p_name), lower(btrim(p_slug)), upper(btrim(p_prefix)))
    returning id into v_id;
  if nullif(btrim(coalesce(p_admin_email, '')), '') is not null then
    perform public.inventory_set_member(v_id, p_admin_email, 'admin');
  end if;
  return v_id;
end $$;
revoke all on function public.inventory_create_lab(text, text, text, text) from public, anon;
grant execute on function public.inventory_create_lab(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Platform administrator tools: labs and users overview
-- ---------------------------------------------------------------------------
create or replace function public.inventory_list_labs() returns table
  (id uuid, name text, slug text, barcode_prefix text, active boolean, created_at timestamptz,
   member_count bigint, container_count bigint, admins text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.inventory_is_platform_admin() then raise exception 'Only the Inventory Administrator can list labs' using errcode = '42501'; end if;
  return query
    select l.id, l.name, l.slug, l.barcode_prefix, l.active, l.created_at,
      (select count(*) from public.inventory_members m where m.lab_id = l.id),
      (select count(*) from public.inventory_containers c where c.lab_id = l.id and c.status <> 'disposed'),
      coalesce((select string_agg(coalesce(p.email, p.full_name), ', ' order by p.email)
                from public.inventory_members m join public.inventory_user_profiles p on p.user_id = m.user_id
                where m.lab_id = l.id and m.role = 'admin'), '')
    from public.inventory_labs l order by l.name;
end $$;

create or replace function public.inventory_update_lab(p_lab_id uuid, p_name text default null, p_active boolean default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.inventory_is_platform_admin() then raise exception 'Only the Inventory Administrator can edit labs' using errcode = '42501'; end if;
  if p_name is not null and btrim(p_name) = '' then raise exception 'Lab name is required' using errcode = '22023'; end if;
  update public.inventory_labs set name = coalesce(nullif(btrim(p_name), ''), name), active = coalesce(p_active, active) where id = p_lab_id;
  if not found then raise exception 'Lab not found' using errcode = '22023'; end if;
end $$;

create or replace function public.inventory_list_all_users() returns table
  (user_id uuid, full_name text, email text, account_status text, platform_admin boolean, labs jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.inventory_is_platform_admin() then raise exception 'Only the Inventory Administrator can list all users' using errcode = '42501'; end if;
  return query
    select p.user_id, p.full_name, p.email, p.account_status,
      exists (select 1 from public.inventory_platform_admins pa where pa.user_id = p.user_id),
      coalesce((select jsonb_agg(jsonb_build_object('lab_id', l.id, 'lab_name', l.name, 'role', m.role) order by l.name)
                from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id where m.user_id = p.user_id), '[]'::jsonb)
    from public.inventory_user_profiles p order by lower(coalesce(p.full_name, p.email));
end $$;

revoke all on function public.inventory_list_labs(), public.inventory_update_lab(uuid, text, boolean), public.inventory_list_all_users() from public, anon;
grant execute on function public.inventory_list_labs(), public.inventory_update_lab(uuid, text, boolean), public.inventory_list_all_users() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. GHS hazard codes on chemicals
-- ---------------------------------------------------------------------------
alter table public.inventory_chemicals add column if not exists ghs_codes text[] not null default '{}';
create index if not exists inventory_chemicals_ghs_idx on public.inventory_chemicals using gin (ghs_codes);

-- ---------------------------------------------------------------------------
-- 5. Register a container: GHS codes, optional pre-printed barcode, platform administrator may own containers
-- ---------------------------------------------------------------------------
create or replace function public.inventory_register_container_phase3(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid := public.inventory_current_lab();
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_cas text := nullif(btrim(coalesce(p ->> 'cas', '')), '');
  v_barcode text := nullif(btrim(coalesce(p ->> 'barcode', '')), '');
  v_ghs text[];
  v_chem uuid; v_container public.inventory_containers; v_same int; v_owner uuid; v_size numeric; v_rem numeric;
  v_loc uuid := nullif(p ->> 'location_id', '')::uuid;
begin
  if v_lab is null then raise exception 'No active lab selected' using errcode = '42501'; end if;
  if not public.inventory_is_manager() then raise exception 'Only managers can register containers' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'Chemical name is required' using errcode = '22023'; end if;
  v_size := nullif(p ->> 'container_size', '')::numeric;
  v_rem := nullif(p ->> 'remaining_amount', '')::numeric;
  if v_size is null or v_size <= 0 then raise exception 'Container size must be positive' using errcode = '22023'; end if;
  if not exists (select 1 from public.inventory_locations where id = v_loc and lab_id = v_lab and active) then
    raise exception 'Choose an active storage location' using errcode = '22023';
  end if;
  v_owner := coalesce(nullif(p ->> 'owner_id', '')::uuid, auth.uid());
  if not (exists (select 1 from public.inventory_members where lab_id = v_lab and user_id = v_owner)
          or (v_owner = auth.uid() and public.inventory_is_platform_admin())) then
    raise exception 'The owner must be a member of this lab' using errcode = '22023';
  end if;
  if v_barcode is not null and exists (select 1 from public.inventory_containers where lab_id = v_lab and barcode = v_barcode) then
    raise exception 'Barcode % is already assigned to another container', v_barcode using errcode = '23505';
  end if;
  if jsonb_typeof(p -> 'ghs_codes') = 'array' then
    select coalesce(array_agg(distinct upper(btrim(x))) filter (where upper(btrim(x)) ~ '^(H|EUH)[0-9]{3}[A-Za-z]{0,3}$'), '{}') into v_ghs
      from jsonb_array_elements_text(p -> 'ghs_codes') x;
  end if;

  if v_cas is not null then
    select id into v_chem from public.inventory_chemicals where lab_id = v_lab and cas = v_cas;
    if v_chem is null then
      select id into v_chem from public.inventory_chemicals where lab_id = v_lab and cas is null and lower(name) = lower(v_name) order by created_at limit 1;
      if v_chem is not null then update public.inventory_chemicals set cas = v_cas where id = v_chem; end if;
    end if;
  else
    select id into v_chem from public.inventory_chemicals where lab_id = v_lab and lower(name) = lower(v_name) order by created_at limit 1;
  end if;
  if v_chem is null then
    insert into public.inventory_chemicals (lab_id, name, cas, formula, notes, ghs_codes)
    values (v_lab, v_name, v_cas, nullif(btrim(coalesce(p ->> 'formula', '')), ''), nullif(btrim(coalesce(p ->> 'chemical_notes', '')), ''), coalesce(v_ghs, '{}'))
    returning id into v_chem;
  else
    update public.inventory_chemicals
      set formula = coalesce(formula, nullif(btrim(coalesce(p ->> 'formula', '')), '')),
          ghs_codes = case when coalesce(cardinality(v_ghs), 0) > 0 then v_ghs else ghs_codes end
      where id = v_chem;
  end if;

  select count(*) into v_same from public.inventory_containers
    where lab_id = v_lab and chemical_id = v_chem and location_id = v_loc and status <> 'disposed';

  insert into public.inventory_containers (lab_id, chemical_id, location_id, owner_id, barcode, container_size, remaining_amount, unit,
      supplier, catalog_number, lot_number, purity, received_at, expires_at, notes)
  values (v_lab, v_chem, v_loc, v_owner, v_barcode, v_size, coalesce(v_rem, v_size), coalesce(nullif(btrim(coalesce(p ->> 'unit', '')), ''), 'g'),
      nullif(btrim(coalesce(p ->> 'supplier', '')), ''), nullif(btrim(coalesce(p ->> 'catalog_number', '')), ''),
      nullif(btrim(coalesce(p ->> 'lot_number', '')), ''), nullif(btrim(coalesce(p ->> 'purity', '')), ''),
      nullif(p ->> 'received_at', '')::date, nullif(p ->> 'expires_at', '')::date, nullif(btrim(coalesce(p ->> 'notes', '')), ''))
  returning * into v_container;

  return jsonb_build_object('container_id', v_container.id, 'chemical_id', v_chem, 'barcode', v_container.barcode, 'same_location_count', v_same);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Container actions: platform administrator may transfer to itself; new bulk action
-- ---------------------------------------------------------------------------
create or replace function public.inventory_container_action_phase3(p_id uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab(); c public.inventory_containers; v_amt numeric; v_loc uuid; v_owner uuid;
begin
  if v_lab is null then raise exception 'No active lab selected' using errcode = '42501'; end if;
  if not public.inventory_is_manager() then raise exception 'Only managers can change containers' using errcode = '42501'; end if;
  select * into c from public.inventory_containers where id = p_id and lab_id = v_lab for update;
  if not found then raise exception 'Container not found' using errcode = '22023'; end if;
  if c.status = 'disposed' then raise exception 'This container has been disposed' using errcode = '22023'; end if;

  if p_action = 'quantity' then
    v_amt := (p ->> 'remaining_amount')::numeric;
    if v_amt is null or v_amt < 0 then raise exception 'Remaining quantity must be zero or more' using errcode = '22023'; end if;
    if v_amt > c.container_size then raise exception 'Remaining quantity cannot exceed the container size' using errcode = '22023'; end if;
    update public.inventory_containers set remaining_amount = v_amt, status = case when v_amt = 0 then 'empty' else 'active' end where id = p_id;
  elsif p_action = 'move' then
    v_loc := nullif(p ->> 'location_id', '')::uuid;
    if not exists (select 1 from public.inventory_locations where id = v_loc and lab_id = v_lab and active) then
      raise exception 'Choose an active storage location' using errcode = '22023';
    end if;
    update public.inventory_containers set location_id = v_loc where id = p_id;
  elsif p_action = 'transfer' then
    v_owner := nullif(p ->> 'owner_id', '')::uuid;
    if not (exists (select 1 from public.inventory_members m join public.inventory_user_profiles u on u.user_id = m.user_id
                    where m.lab_id = v_lab and m.user_id = v_owner and u.account_status is distinct from 'locked')
            or (v_owner = auth.uid() and public.inventory_is_platform_admin())) then
      raise exception 'The new owner must be an active member of this lab' using errcode = '22023';
    end if;
    update public.inventory_containers set owner_id = v_owner where id = p_id;
  elsif p_action = 'empty' then
    update public.inventory_containers set remaining_amount = 0, status = 'empty' where id = p_id;
  elsif p_action = 'dispose' then
    update public.inventory_containers set status = 'disposed', disposed_at = now() where id = p_id;
  else
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;
  return jsonb_build_object('id', p_id, 'action', p_action);
end $$;

-- Apply move / dispose / transfer to many containers in one call (location "Move All" / "Delete All", search selection).
create or replace function public.inventory_bulk_container_action(p_ids uuid[], p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_done int := 0; v_skipped int := 0;
begin
  if p_action not in ('move', 'dispose', 'transfer') then raise exception 'Unsupported bulk action' using errcode = '22023'; end if;
  if coalesce(cardinality(p_ids), 0) > 2000 then raise exception 'Select at most 2000 containers at a time' using errcode = '22023'; end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    begin
      perform public.inventory_container_action_phase3(v_id, p_action, p);
      v_done := v_done + 1;
    exception when others then
      if sqlstate = '42501' then raise; end if;
      v_skipped := v_skipped + 1;
    end;
  end loop;
  return jsonb_build_object('done', v_done, 'skipped', v_skipped);
end $$;
revoke all on function public.inventory_bulk_container_action(uuid[], text, jsonb) from public, anon;
grant execute on function public.inventory_bulk_container_action(uuid[], text, jsonb) to authenticated;

commit;
