-- Makes sign-in self-repairing: if a user's profile row is missing, or their selected lab is
-- missing / no longer one they belong to, inventory_my_context() fixes it before answering.
-- Safe to run more than once.
begin;

create or replace function public.inventory_my_context() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_lab uuid; v_status text;
begin
  if v_uid is null then return null; end if;

  insert into public.inventory_user_profiles (user_id, full_name, email)
  select u.id, coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(u.email, '@', 1)), u.email
  from auth.users u where u.id = v_uid
  on conflict (user_id) do nothing;

  update public.inventory_user_profiles p
  set active_lab_id = (select m.lab_id from public.inventory_members m
                       join public.inventory_labs l on l.id = m.lab_id and l.active
                       where m.user_id = p.user_id order by m.created_at limit 1)
  where p.user_id = v_uid
    and (p.active_lab_id is null
         or not exists (select 1 from public.inventory_members m where m.user_id = p.user_id and m.lab_id = p.active_lab_id));

  v_lab := public.inventory_current_lab();
  select account_status into v_status from public.inventory_user_profiles where user_id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid,
    'account_status', coalesce(v_status, 'active'),
    'lab_id', v_lab,
    'lab_name', (select name from public.inventory_labs where id = v_lab),
    'role', public.inventory_role(),
    'platform_admin', public.inventory_is_platform_admin(),
    'labs', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'role', m.role) order by l.name)
                      from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id
                      where m.user_id = v_uid and l.active), '[]'::jsonb));
end $$;

revoke all on function public.inventory_my_context() from public, anon;
grant execute on function public.inventory_my_context() to authenticated;

commit;
