-- Lab / user rules:
--  * The Inventory Administrator (platform administrator) can never be a member, chemical manager or administrator of
--    a lab. Enforced in the database, so no screen, API call or invitation can add the account to a lab.
--  * Every lab must have a lab administrator. The last administrator of a lab cannot be removed, demoted or deleted;
--    the administrator is changed with inventory_change_lab_admin (Inventory Administrator or the lab's own administrator).
--  * New labs must be created with an administrator e-mail.
--  * Existing memberships of the Inventory Administrator are removed (their lab then shows "Administrator required"
--    until the Inventory Administrator assigns one).
--
-- Safe to run more than once. Run after 01..07.

begin;

-- 1. Guard triggers -------------------------------------------------------------------------------------------------
create or replace function public.inventory_guard_members() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row public.inventory_members;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    if (tg_op = 'INSERT' or new.user_id is distinct from old.user_id)
       and exists (select 1 from public.inventory_platform_admins pa where pa.user_id = new.user_id) then
      raise exception 'The Inventory Administrator cannot be added to a lab' using errcode = '22023';
    end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'admin' and (tg_op = 'DELETE' or new.role is distinct from 'admin')
     and not exists (select 1 from public.inventory_platform_admins pa where pa.user_id = old.user_id)
     and exists (select 1 from public.inventory_labs l where l.id = old.lab_id)
     and not exists (select 1 from public.inventory_members m
                     where m.lab_id = old.lab_id and m.role = 'admin' and m.user_id <> old.user_id
                       and not exists (select 1 from public.inventory_platform_admins pa where pa.user_id = m.user_id)) then
    raise exception 'A lab needs at least one administrator. Assign another administrator first.' using errcode = '22023';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists inventory_guard_members on public.inventory_members;
create trigger inventory_guard_members before insert or update or delete on public.inventory_members
  for each row execute function public.inventory_guard_members();

-- 2. Remove the Inventory Administrator from every lab (done before the guard can object: the guard allows deleting
--    a platform administrator's own row, because that row never counted as a lab administrator).
delete from public.inventory_members m
 where exists (select 1 from public.inventory_platform_admins pa where pa.user_id = m.user_id);
update public.inventory_user_profiles p set active_lab_id = null
 where exists (select 1 from public.inventory_platform_admins pa where pa.user_id = p.user_id);
delete from public.inventory_pending_members pm
 where pm.platform_admin or exists (select 1 from auth.users u join public.inventory_platform_admins pa on pa.user_id = u.id
                                     where lower(u.email) = lower(pm.email));

-- 3. Add / change members: the Inventory Administrator is refused with a clear message --------------------------------
create or replace function public.inventory_set_member(p_lab_id uuid, p_email text, p_role text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_user uuid;
begin
  if p_role not in ('member', 'manager', 'admin') then raise exception 'Invalid role' using errcode = '22023'; end if;
  if not (public.inventory_is_platform_admin()
          or exists (select 1 from public.inventory_members m where m.user_id = auth.uid() and m.lab_id = p_lab_id and m.role = 'admin')) then
    raise exception 'Only lab administrators can manage members' using errcode = '42501';
  end if;
  if not exists (select 1 from public.inventory_labs where id = p_lab_id) then raise exception 'Lab not found' using errcode = '22023'; end if;
  select id into v_user from auth.users where lower(email) = v_email limit 1;
  if v_user is not null and exists (select 1 from public.inventory_platform_admins pa where pa.user_id = v_user) then
    raise exception 'The Inventory Administrator cannot be added to a lab' using errcode = '22023';
  end if;
  if v_user is null then
    insert into public.inventory_pending_members (email, lab_id, role) values (v_email, p_lab_id, p_role)
      on conflict (email, lab_id) do update set role = excluded.role;
    return 'pending';
  end if;
  insert into public.inventory_members (lab_id, user_id, role) values (p_lab_id, v_user, p_role)
    on conflict (lab_id, user_id) do update set role = excluded.role;
  update public.inventory_user_profiles set active_lab_id = p_lab_id where user_id = v_user and active_lab_id is null;
  return 'member';
end $$;

-- 4. New labs need an administrator ----------------------------------------------------------------------------------
create or replace function public.inventory_create_lab(p_name text, p_slug text, p_prefix text default 'CH', p_admin_email text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.inventory_is_platform_admin() then raise exception 'Only the Inventory Administrator can create labs' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_admin_email, '')), '') is null then raise exception 'A lab needs an administrator: enter the administrator''s e-mail' using errcode = '22023'; end if;
  if exists (select 1 from auth.users u join public.inventory_platform_admins pa on pa.user_id = u.id where lower(u.email) = lower(btrim(p_admin_email))) then
    raise exception 'The Inventory Administrator cannot be added to a lab' using errcode = '22023';
  end if;
  insert into public.inventory_labs (name, slug, barcode_prefix) values (btrim(p_name), lower(btrim(p_slug)), upper(btrim(p_prefix)))
    returning id into v_id;
  perform public.inventory_set_member(v_id, p_admin_email, 'admin');
  return v_id;
end $$;

-- 5. Change the administrator of a lab -------------------------------------------------------------------------------
-- Inventory Administrator: any active account (or an e-mail that is invited as administrator when not registered yet).
-- Lab administrator: any existing member of their own lab. The new administrator is added if needed; the previous
-- administrator(s) become Chemical Managers.
create or replace function public.inventory_change_lab_admin(p_lab_id uuid, p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_user uuid; v_platform boolean := public.inventory_is_platform_admin(); v_status text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.inventory_labs where id = p_lab_id) then raise exception 'Lab not found' using errcode = '22023'; end if;
  if not (v_platform or exists (select 1 from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id
                                where m.user_id = auth.uid() and m.lab_id = p_lab_id and m.role = 'admin' and l.active)) then
    raise exception 'Only the Inventory Administrator or the lab administrator can change the administrator' using errcode = '42501';
  end if;
  if v_email is null or v_email = '' then raise exception 'Enter the new administrator''s e-mail' using errcode = '22023'; end if;
  select u.id into v_user from auth.users u where lower(u.email) = v_email limit 1;
  if v_user is not null and exists (select 1 from public.inventory_platform_admins pa where pa.user_id = v_user) then
    raise exception 'The Inventory Administrator cannot be added to a lab' using errcode = '22023';
  end if;
  if v_user is null then
    if not v_platform then raise exception 'That person is not a member of this lab' using errcode = '22023'; end if;
    delete from public.inventory_pending_members where lab_id = p_lab_id and role = 'admin' and lower(email) <> v_email;
    insert into public.inventory_pending_members (email, lab_id, role) values (v_email, p_lab_id, 'admin')
      on conflict (email, lab_id) do update set role = 'admin';
    return 'pending';
  end if;
  if not v_platform and not exists (select 1 from public.inventory_members m where m.lab_id = p_lab_id and m.user_id = v_user) then
    raise exception 'That person is not a member of this lab' using errcode = '22023';
  end if;
  select account_status into v_status from public.inventory_user_profiles where user_id = v_user;
  if v_status = 'locked' then raise exception 'That account is locked. Unlock it first' using errcode = '22023'; end if;
  insert into public.inventory_members (lab_id, user_id, role) values (p_lab_id, v_user, 'admin')
    on conflict (lab_id, user_id) do update set role = 'admin';
  update public.inventory_members set role = 'manager' where lab_id = p_lab_id and role = 'admin' and user_id <> v_user;
  delete from public.inventory_pending_members where lab_id = p_lab_id and role = 'admin';
  update public.inventory_user_profiles set active_lab_id = p_lab_id where user_id = v_user and active_lab_id is null;
  return 'member';
end $$;
revoke all on function public.inventory_change_lab_admin(uuid, text) from public, anon;
grant execute on function public.inventory_change_lab_admin(uuid, text) to authenticated;

commit;
