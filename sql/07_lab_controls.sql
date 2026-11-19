-- Lab controls: deactivated labs block sign-in (with a clear reason), the Inventory Administrator can still
-- sign in when every lab is deactivated (so labs can be activated again), and labs can never be deleted from the app.
--
--  * Deactivate / activate a lab: Inventory Administrator only (inventory_update_lab, unchanged).
--  * Members of a deactivated lab are refused at sign-in: inventory_my_context returns lab_deactivated = true
--    when none of their labs is active. People who also belong to an active lab keep signing in to that lab.
--  * Nothing deletes labs: the delete privilege is revoked (there is also no delete policy and no delete button).
--
-- Safe to run more than once. Run after 01..06.

begin;

create or replace function public.inventory_my_context() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_lab uuid; v_status text; v_platform boolean; v_deactivated boolean;
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
  -- A person whose only labs are deactivated cannot sign in; the app tells them why.
  v_deactivated := not v_platform and v_lab is null
    and exists (select 1 from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id and not l.active where m.user_id = v_uid)
    and not exists (select 1 from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id and l.active where m.user_id = v_uid);
  return jsonb_build_object(
    'user_id', v_uid,
    'account_status', coalesce(v_status, 'active'),
    'lab_id', v_lab,
    'lab_name', (select name from public.inventory_labs where id = v_lab),
    'role', case when v_platform then 'admin' else public.inventory_role() end,
    'lab_deactivated', coalesce(v_deactivated, false),
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

revoke delete on public.inventory_labs from authenticated, anon;

commit;
