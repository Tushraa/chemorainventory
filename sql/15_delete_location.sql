-- Permanent deletion of a location, allowed only after it has been deactivated.
-- Run once in the Supabase SQL editor. Safe to run again.
-- Rules (checked here, not only in the app):
--   * lab administrators only, for a location of their current lab;
--   * the location must already be inactive;
--   * it must not contain other locations;
--   * no container (including disposed ones) may still be recorded in it, because those records point to it.
-- The deletion is written to Activity History & Auditing by the existing change log ("Location <name> deleted").
create or replace function public.inventory_delete_location(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid := public.inventory_current_lab();
  l record;
  n integer;
begin
  if auth.uid() is null or v_lab is null or not public.inventory_is_admin() then
    raise exception 'Only lab administrators can delete locations' using errcode = '42501';
  end if;
  select * into l from public.inventory_locations where id = p_id and lab_id = v_lab for update;
  if not found then raise exception 'Location not found' using errcode = '22023'; end if;
  if coalesce(l.active, true) then
    raise exception 'Deactivate the location before deleting it permanently' using errcode = '22023';
  end if;
  select count(*) into n from public.inventory_locations where lab_id = v_lab and parent_id = p_id;
  if n > 0 then
    raise exception 'This location contains % other location(s). Delete or move them first.', n using errcode = '22023';
  end if;
  select count(*) into n from public.inventory_containers where lab_id = v_lab and location_id = p_id;
  if n > 0 then
    raise exception '% container record(s), including disposed ones, are still stored in this location, so it cannot be deleted. Keep it deactivated instead.', n using errcode = '22023';
  end if;
  delete from public.inventory_locations where id = p_id and lab_id = v_lab;
end $$;
revoke all on function public.inventory_delete_location(uuid) from public, anon;
grant execute on function public.inventory_delete_location(uuid) to authenticated;
