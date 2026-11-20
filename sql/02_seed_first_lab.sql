-- Creates the first lab and invites the first administrator.
-- Before running, replace the laboratory name ('My Laboratory'), its short name ('my-laboratory'),
-- the barcode prefix ('ML') and the administrator e-mail ('admin@example.com') with your own.
-- Safe to run before or after the person has an account: when the e-mail signs up
-- (or is invited in Authentication > Users), the trigger gives them the roles below automatically.
-- If the account already exists, the roles are applied immediately.

begin;

insert into public.inventory_labs (name, slug, barcode_prefix)
values ('My Laboratory', 'my-laboratory', 'ML');

insert into public.inventory_pending_members (email, lab_id, role, platform_admin)
select 'admin@example.com', id, 'admin', true from public.inventory_labs where slug = 'my-laboratory';

do $$
declare v_user uuid; v_lab uuid;
begin
  select id into v_user from auth.users where lower(email) = 'admin@example.com';
  select id into v_lab from public.inventory_labs where slug = 'my-laboratory';
  if v_user is not null then
    insert into public.inventory_user_profiles (user_id, full_name, email)
      values (v_user, split_part('admin@example.com', '@', 1), 'admin@example.com') on conflict (user_id) do nothing;
    insert into public.inventory_members (lab_id, user_id, role) values (v_lab, v_user, 'admin')
      on conflict (lab_id, user_id) do update set role = 'admin';
    insert into public.inventory_platform_admins (user_id) values (v_user) on conflict do nothing;
    update public.inventory_user_profiles set active_lab_id = v_lab where user_id = v_user and active_lab_id is null;
    delete from public.inventory_pending_members where lower(email) = 'admin@example.com';
  end if;
end $$;

commit;
