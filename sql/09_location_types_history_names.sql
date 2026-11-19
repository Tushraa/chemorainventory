-- 1. Location types: Cabinet, Shelf, Fridge and Tray. Only Cabinet, Shelf and Fridge can contain other locations.
--    A location may be top level (no parent). Locations created earlier with the old types (building / room / position)
--    keep working and can still be viewed, but new or edited locations must use the four types above.
-- 2. Activity History: inventory_history_names() returns display names for the people who appear in the lab's activity
--    log, including the Inventory Administrator and members who have since left the lab.
--
-- Safe to run more than once. Run after 01..08.

begin;

-- 1. Location types -------------------------------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.inventory_locations'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) ilike '%location_type%') loop
    execute format('alter table public.inventory_locations drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.inventory_locations
  add constraint inventory_locations_type_chk
  check (location_type in ('cabinet', 'shelf', 'fridge', 'tray', 'building', 'room', 'position'));
alter table public.inventory_locations alter column location_type set default 'cabinet';

create or replace function public.inventory_guard_location_type() returns trigger
language plpgsql set search_path = '' as $$
declare v_parent_type text;
begin
  if tg_op = 'INSERT' or new.location_type is distinct from old.location_type then
    if new.location_type not in ('cabinet', 'shelf', 'fridge', 'tray') then
      raise exception 'Location type must be Cabinet, Shelf, Fridge or Tray' using errcode = '22023';
    end if;
  end if;
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    select l.location_type into v_parent_type from public.inventory_locations l
     where l.lab_id = new.lab_id and l.id = new.parent_id;
    if v_parent_type is null or v_parent_type not in ('cabinet', 'shelf', 'fridge') then
      raise exception 'Only a Cabinet, Shelf or Fridge can contain other locations' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists inventory_locations_guard_type on public.inventory_locations;
create trigger inventory_locations_guard_type before insert or update on public.inventory_locations
  for each row execute function public.inventory_guard_location_type();

-- 2. Names in Activity History --------------------------------------------------------------------------------------
create or replace function public.inventory_history_names(p_ids uuid[]) returns table (user_id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email)
    from public.inventory_user_profiles p
   where p.user_id = any (p_ids)
     and auth.uid() is not null
     and (public.inventory_is_platform_admin()
          or (public.inventory_is_manager()
              and exists (select 1 from public.inventory_activity_logs l
                           where l.performed_by = p.user_id and l.lab_id = public.inventory_current_lab())));
$$;
revoke all on function public.inventory_history_names(uuid[]) from public, anon;
grant execute on function public.inventory_history_names(uuid[]) to authenticated;

commit;
