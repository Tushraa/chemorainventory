-- Creates the first lab and invites the first administrator.
-- Safe to run before or after the person has an account: when the e-mail signs up
-- (or is invited in Authentication > Users), the trigger gives them the roles below automatically.
-- If the account already exists, the roles are applied immediately.

begin;

insert into public.inventory_labs (name, slug, barcode_prefix)
values ('Hari Group', 'hari-group', 'HG');

insert into public.inventory_pending_members (email, lab_id, role, platform_admin)
select 'tushraas@iisc.ac.in', id, 'admin', true from public.inventory_labs where slug = 'hari-group';

do $$
declare v_user uuid; v_lab uuid;
begin
  select id into v_user from auth.users where lower(email) = 'tushraas@iisc.ac.in';
  select id into v_lab from public.inventory_labs where slug = 'hari-group';
  if v_user is not null then
    insert into public.inventory_user_profiles (user_id, full_name, email)
      values (v_user, split_part('tushraas@iisc.ac.in', '@', 1), 'tushraas@iisc.ac.in') on conflict (user_id) do nothing;
    insert into public.inventory_members (lab_id, user_id, role) values (v_lab, v_user, 'admin')
      on conflict (lab_id, user_id) do update set role = 'admin';
    insert into public.inventory_platform_admins (user_id) values (v_user) on conflict do nothing;
    update public.inventory_user_profiles set active_lab_id = v_lab where user_id = v_user and active_lab_id is null;
    delete from public.inventory_pending_members where lower(email) = 'tushraas@iisc.ac.in';
  end if;
end $$;

commit;
