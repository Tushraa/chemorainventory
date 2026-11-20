-- Performance: one-call history and user list, plus indexes for text search.
-- Run once in the Supabase SQL editor. Safe to run again. The app falls back to the old (slower) way
-- until this script has been run, so it can be run before or after the new app version goes live.

-- 1. Activity History in one call: date range filtered on the server, names included ------------------------------------
--    p_from / p_to are UTC days (either may be null); at most p_limit newest rows are returned (default 2000, max 5000).
create or replace function public.inventory_history_page(p_from date default null, p_to date default null, p_limit integer default 2000)
returns table (created_at timestamptz, table_name text, record_id uuid, action text, performed_by uuid, description text, performer_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab();
begin
  if auth.uid() is null or v_lab is null or not public.inventory_is_manager() then
    raise exception 'Only chemical managers and administrators can view the activity history' using errcode = '42501';
  end if;
  return query
    select l.created_at, l.table_name, l.record_id, l.action, l.performed_by, l.description,
           coalesce(nullif(btrim(p.full_name), ''), p.email) as performer_name
      from public.inventory_activity_logs l
      left join public.inventory_user_profiles p on p.user_id = l.performed_by
     where l.lab_id = v_lab
       and (p_from is null or l.created_at >= (p_from::timestamp at time zone 'UTC'))
       and (p_to is null or l.created_at < ((p_to + 1)::timestamp at time zone 'UTC'))
     order by l.created_at desc
     limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
end $$;
revoke all on function public.inventory_history_page(date, date, integer) from public, anon;
grant execute on function public.inventory_history_page(date, date, integer) to authenticated;

-- 2. User accounts list in one call (replaces a slower edge-function round trip) --------------------------------------
--    Lab administrators see the members of their current lab; the Inventory Administrator sees the lab they are in.
create or replace function public.inventory_lab_users()
returns table (user_id uuid, role text, full_name text, email text, account_status text, platform_admin boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab();
begin
  if auth.uid() is null or v_lab is null or not (public.inventory_is_admin() or public.inventory_is_platform_admin()) then
    raise exception 'Only lab administrators can manage accounts' using errcode = '42501';
  end if;
  return query
    select m.user_id, m.role, coalesce(p.full_name, ''), coalesce(p.email, ''), coalesce(p.account_status, 'active'),
           exists (select 1 from public.inventory_platform_admins a where a.user_id = m.user_id)
      from public.inventory_members m
      left join public.inventory_user_profiles p on p.user_id = m.user_id
     where m.lab_id = v_lab
     order by coalesce(nullif(btrim(p.full_name), ''), p.email);
end $$;
revoke all on function public.inventory_lab_users() from public, anon;
grant execute on function public.inventory_lab_users() to authenticated;

-- 3. Indexes so that "contains" searches (name, CAS, synonym, barcode) stay fast as the inventory grows ---------------
create extension if not exists pg_trgm with schema extensions;
create index if not exists inventory_chemicals_name_trgm on public.inventory_chemicals using gin (name extensions.gin_trgm_ops);
create index if not exists inventory_chemicals_cas_trgm on public.inventory_chemicals using gin (cas extensions.gin_trgm_ops);
create index if not exists inventory_synonyms_text_trgm on public.inventory_chemical_synonyms using gin (synonym extensions.gin_trgm_ops);
create index if not exists inventory_containers_barcode_trgm on public.inventory_containers using gin (barcode extensions.gin_trgm_ops);
create index if not exists inventory_containers_status_idx on public.inventory_containers (lab_id, status);
create index if not exists inventory_user_profiles_email_idx on public.inventory_user_profiles (lower(email));
