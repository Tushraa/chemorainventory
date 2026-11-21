-- Permanent location deletion now also removes the DISPOSED container records stored in that location.
-- (Disposed containers are hidden in the app but still point to their location, which blocked the deletion.)
-- Run once in the Supabase SQL editor, after sql/15. Safe to run again.
-- Rules: lab administrator of the current lab; location already inactive; no other locations inside it;
-- no container that is still in use (anything not disposed). Disposed containers are deleted with it,
-- and their audit-history lines remain. Orders that referenced them are kept (the link is cleared).
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
  select count(*) into n from public.inventory_containers
   where lab_id = v_lab and location_id = p_id and coalesce(status, '') <> 'disposed';
  if n > 0 then
    raise exception '% container(s) are still stored in this location. Move or dispose of them first.', n using errcode = '22023';
  end if;
  delete from public.inventory_containers where lab_id = v_lab and location_id = p_id and status = 'disposed';
  delete from public.inventory_locations where id = p_id and lab_id = v_lab;
end $$;
revoke all on function public.inventory_delete_location(uuid) from public, anon;
grant execute on function public.inventory_delete_location(uuid) to authenticated;
