-- Chemora multi-lab schema for Supabase (free plan friendly: no extensions, no extra services)
-- One project, many labs. Every data row carries lab_id and row-level security (RLS)
-- only lets a user see rows of the lab they currently have selected AND belong to.
-- Run once on an EMPTY project. It is wrapped in a transaction: if anything fails, nothing is applied.

begin;

-- ============================================================================
-- 1. Labs, users, memberships
-- ============================================================================
create table public.inventory_labs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  barcode_prefix text not null default 'CH' check (barcode_prefix ~ '^[A-Z0-9]{1,8}$'),
  next_barcode bigint not null default 1,
  next_location_barcode bigint not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint inventory_labs_slug_key unique (slug)
);
create unique index inventory_labs_name_key on public.inventory_labs (lower(name));

create table public.inventory_user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  account_status text not null default 'active' check (account_status in ('active', 'locked')),
  active_lab_id uuid references public.inventory_labs (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.inventory_members (
  lab_id uuid not null references public.inventory_labs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('member', 'manager', 'admin')),
  created_at timestamptz not null default now(),
  primary key (lab_id, user_id)
);
create index inventory_members_user_idx on public.inventory_members (user_id);

create table public.inventory_platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Invitations for people who have not signed up yet. Applied automatically when the account is created.
create table public.inventory_pending_members (
  email text not null,
  lab_id uuid not null references public.inventory_labs (id) on delete cascade,
  role text not null check (role in ('member', 'manager', 'admin')),
  platform_admin boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (email, lab_id)
);

-- ============================================================================
-- 2. Helper functions used by RLS (security definer so they can read the tables above)
-- ============================================================================
create function public.inventory_current_lab() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.active_lab_id
  from public.inventory_user_profiles p
  join public.inventory_members m on m.lab_id = p.active_lab_id and m.user_id = p.user_id
  join public.inventory_labs l on l.id = p.active_lab_id and l.active
  where p.user_id = auth.uid() and p.account_status is distinct from 'locked'
$$;

create function public.inventory_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.inventory_members m
  where m.user_id = auth.uid() and m.lab_id = public.inventory_current_lab()
$$;

create function public.inventory_is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.inventory_role() in ('manager', 'admin'), false)
$$;

create function public.inventory_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.inventory_role() = 'admin', false)
$$;

create function public.inventory_is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inventory_platform_admins where user_id = auth.uid())
$$;

-- ============================================================================
-- 3. Lab data tables (every row belongs to exactly one lab)
-- ============================================================================
create table public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null default public.inventory_current_lab() references public.inventory_labs (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  description text,
  location_type text not null default 'room' check (location_type in ('building', 'room', 'cabinet', 'shelf', 'position')),
  parent_id uuid,
  barcode text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint inventory_locations_lab_id_key unique (lab_id, id),
  constraint inventory_locations_barcode_key unique (lab_id, barcode),
  constraint inventory_locations_parent_fk foreign key (lab_id, parent_id) references public.inventory_locations (lab_id, id),
  constraint inventory_locations_parent_chk check ((location_type = 'building') = (parent_id is null))
);
create unique index inventory_locations_name_key
  on public.inventory_locations (lab_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

create table public.inventory_chemicals (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null default public.inventory_current_lab() references public.inventory_labs (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  cas text check (cas is null or cas ~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$'),
  formula text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_chemicals_lab_id_key unique (lab_id, id)
);
create unique index inventory_chemicals_cas_key on public.inventory_chemicals (lab_id, cas) where cas is not null;
create index inventory_chemicals_name_idx on public.inventory_chemicals (lab_id, lower(name));

create table public.inventory_chemical_synonyms (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null default public.inventory_current_lab() references public.inventory_labs (id) on delete cascade,
  chemical_id uuid not null,
  synonym text not null check (btrim(synonym) <> ''),
  created_at timestamptz not null default now(),
  constraint inventory_synonyms_chemical_fk foreign key (lab_id, chemical_id)
    references public.inventory_chemicals (lab_id, id) on delete cascade
);
create index inventory_synonyms_chemical_idx on public.inventory_chemical_synonyms (lab_id, chemical_id);
create index inventory_synonyms_text_idx on public.inventory_chemical_synonyms (lab_id, lower(synonym));

create table public.inventory_containers (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null default public.inventory_current_lab() references public.inventory_labs (id) on delete cascade,
  chemical_id uuid not null,
  location_id uuid not null,
  owner_id uuid references auth.users (id) on delete set null,
  barcode text,
  container_size numeric not null check (container_size > 0),
  remaining_amount numeric check (remaining_amount >= 0),
  unit text not null check (btrim(unit) <> ''),
  supplier text,
  catalog_number text,
  lot_number text,
  purity text,
  received_at date,
  expires_at date,
  notes text,
  status text not null default 'active' check (status in ('active', 'empty', 'disposed')),
  disposed_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_containers_lab_id_key unique (lab_id, id),
  constraint inventory_containers_barcode_key unique (lab_id, barcode),
  constraint inventory_containers_chemical_fk foreign key (lab_id, chemical_id) references public.inventory_chemicals (lab_id, id),
  constraint inventory_containers_location_fk foreign key (lab_id, location_id) references public.inventory_locations (lab_id, id),
  constraint inventory_containers_amount_chk check (remaining_amount is null or remaining_amount <= container_size),
  constraint inventory_containers_dates_chk check (expires_at is null or received_at is null or expires_at >= received_at)
);
create index inventory_containers_chemical_idx on public.inventory_containers (lab_id, chemical_id);
create index inventory_containers_location_idx on public.inventory_containers (lab_id, location_id);
create index inventory_containers_owner_idx on public.inventory_containers (owner_id);

create table public.inventory_orders (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null default public.inventory_current_lab() references public.inventory_labs (id) on delete cascade,
  chemical_name text not null check (btrim(chemical_name) <> ''),
  cas text check (cas is null or cas ~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$'),
  container_size numeric not null check (container_size > 0),
  unit text not null check (btrim(unit) <> ''),
  supplier text,
  comments text,
  status text not null default 'requested' check (status in ('requested', 'ordered', 'received', 'cancelled')),
  requested_by uuid default auth.uid() references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  ordered_at timestamptz,
  received_at timestamptz,
  received_container_id uuid references public.inventory_containers (id) on delete set null
);
create index inventory_orders_lab_status_idx on public.inventory_orders (lab_id, status, requested_at desc);
create index inventory_orders_container_idx on public.inventory_orders (received_container_id);

create table public.inventory_activity_logs (
  id bigint generated always as identity primary key,
  lab_id uuid not null default public.inventory_current_lab() references public.inventory_labs (id) on delete cascade,
  table_name text not null,
  record_id uuid,
  action text not null,
  performed_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index inventory_logs_lab_time_idx on public.inventory_activity_logs (lab_id, created_at desc);

-- ============================================================================
-- 4. Triggers: barcodes, updated_at, activity log
-- ============================================================================
create function public.inventory_assign_container_barcode() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_n bigint;
begin
  if new.barcode is null or btrim(new.barcode) = '' then
    update public.inventory_labs set next_barcode = next_barcode + 1
      where id = new.lab_id returning barcode_prefix, next_barcode - 1 into v_prefix, v_n;
    new.barcode := v_prefix || '-' || lpad(v_n::text, 6, '0');
  end if;
  return new;
end $$;
create trigger inventory_containers_barcode before insert on public.inventory_containers
  for each row execute function public.inventory_assign_container_barcode();

create function public.inventory_assign_location_barcode() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_n bigint;
begin
  if new.barcode is null or btrim(new.barcode) = '' then
    update public.inventory_labs set next_location_barcode = next_location_barcode + 1
      where id = new.lab_id returning barcode_prefix, next_location_barcode - 1 into v_prefix, v_n;
    new.barcode := v_prefix || '-L' || lpad(v_n::text, 5, '0');
  end if;
  return new;
end $$;
create trigger inventory_locations_barcode before insert on public.inventory_locations
  for each row execute function public.inventory_assign_location_barcode();

create function public.inventory_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger inventory_chemicals_touch before update on public.inventory_chemicals
  for each row execute function public.inventory_touch_updated_at();
create trigger inventory_containers_touch before update on public.inventory_containers
  for each row execute function public.inventory_touch_updated_at();

create function public.inventory_log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  insert into public.inventory_activity_logs (lab_id, table_name, record_id, action, performed_by)
  values (r.lab_id, tg_table_name, r.id, lower(tg_op), auth.uid());
  return null;
end $$;
create trigger inventory_locations_log after insert or update or delete on public.inventory_locations
  for each row execute function public.inventory_log_change();
create trigger inventory_chemicals_log after insert or update or delete on public.inventory_chemicals
  for each row execute function public.inventory_log_change();
create trigger inventory_containers_log after insert or update or delete on public.inventory_containers
  for each row execute function public.inventory_log_change();
create trigger inventory_orders_log after insert or update or delete on public.inventory_orders
  for each row execute function public.inventory_log_change();

-- New sign-ups: create the profile and apply any pending invitation for that e-mail address.
create function public.inventory_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_first uuid;
begin
  insert into public.inventory_user_profiles (user_id, full_name, email)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
          new.email)
  on conflict (user_id) do nothing;

  insert into public.inventory_members (lab_id, user_id, role)
  select pm.lab_id, new.id, pm.role from public.inventory_pending_members pm
  where lower(pm.email) = lower(new.email)
  on conflict (lab_id, user_id) do update set role = excluded.role;

  if exists (select 1 from public.inventory_pending_members pm where lower(pm.email) = lower(new.email) and pm.platform_admin) then
    insert into public.inventory_platform_admins (user_id) values (new.id) on conflict do nothing;
  end if;

  select m.lab_id into v_first from public.inventory_members m
    where m.user_id = new.id order by m.created_at limit 1;
  update public.inventory_user_profiles set active_lab_id = v_first where user_id = new.id and active_lab_id is null;

  delete from public.inventory_pending_members where lower(email) = lower(new.email);
  return new;
end $$;
create trigger inventory_on_auth_user_created after insert on auth.users
  for each row execute function public.inventory_handle_new_user();

-- ============================================================================
-- 5. Row-level security
-- ============================================================================
alter table public.inventory_labs enable row level security;
alter table public.inventory_user_profiles enable row level security;
alter table public.inventory_members enable row level security;
alter table public.inventory_platform_admins enable row level security;
alter table public.inventory_pending_members enable row level security;
alter table public.inventory_locations enable row level security;
alter table public.inventory_chemicals enable row level security;
alter table public.inventory_chemical_synonyms enable row level security;
alter table public.inventory_containers enable row level security;
alter table public.inventory_orders enable row level security;
alter table public.inventory_activity_logs enable row level security;

-- Nothing is readable by anonymous visitors.
revoke all on all tables in schema public from anon;

create policy labs_select on public.inventory_labs for select to authenticated
  using (id in (select m.lab_id from public.inventory_members m where m.user_id = (select auth.uid()))
         or (select public.inventory_is_platform_admin()));

create policy profiles_select on public.inventory_user_profiles for select to authenticated
  using (user_id = (select auth.uid())
         or exists (select 1 from public.inventory_members m
                    where m.user_id = inventory_user_profiles.user_id and m.lab_id = (select public.inventory_current_lab())));

create policy members_select on public.inventory_members for select to authenticated
  using (user_id = (select auth.uid()) or lab_id = (select public.inventory_current_lab()));

create policy platform_admins_select on public.inventory_platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

-- inventory_pending_members: no policy = no direct access (only the functions below touch it).

-- Read access: any member of the current lab.
create policy locations_select on public.inventory_locations for select to authenticated
  using (lab_id = (select public.inventory_current_lab()));
create policy chemicals_select on public.inventory_chemicals for select to authenticated
  using (lab_id = (select public.inventory_current_lab()));
create policy synonyms_select on public.inventory_chemical_synonyms for select to authenticated
  using (lab_id = (select public.inventory_current_lab()));
create policy containers_select on public.inventory_containers for select to authenticated
  using (lab_id = (select public.inventory_current_lab()));
create policy orders_select on public.inventory_orders for select to authenticated
  using (lab_id = (select public.inventory_current_lab()));
create policy logs_select on public.inventory_activity_logs for select to authenticated
  using (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()));

-- Locations: administrators manage them (the CSV importer also creates them).
create policy locations_insert on public.inventory_locations for insert to authenticated
  with check (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_admin()));
create policy locations_update on public.inventory_locations for update to authenticated
  using (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_admin()))
  with check (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_admin()));

-- Chemicals, synonyms and containers: managers edit details (creation, moves and deletion go through the functions below).
create policy chemicals_update on public.inventory_chemicals for update to authenticated
  using (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()))
  with check (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()));
create policy synonyms_write on public.inventory_chemical_synonyms for all to authenticated
  using (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()))
  with check (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()));
create policy containers_update on public.inventory_containers for update to authenticated
  using (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()))
  with check (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()));

-- Orders: any member can request; changes go through the order functions.
create policy orders_insert on public.inventory_orders for insert to authenticated
  with check (lab_id = (select public.inventory_current_lab())
              and requested_by = (select auth.uid())
              and status = 'requested');

-- ============================================================================
-- 6. Context, lab switching and membership management
-- ============================================================================
create function public.inventory_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_lab uuid := public.inventory_current_lab(); v_status text;
begin
  if v_uid is null then return null; end if;
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

create function public.inventory_switch_lab(p_lab_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.inventory_members m join public.inventory_labs l on l.id = m.lab_id
                 where m.user_id = auth.uid() and m.lab_id = p_lab_id and l.active) then
    raise exception 'You are not a member of that lab' using errcode = '42501';
  end if;
  update public.inventory_user_profiles set active_lab_id = p_lab_id where user_id = auth.uid();
  return public.inventory_my_context();
end $$;

-- Platform administrators only.
create function public.inventory_create_lab(p_name text, p_slug text, p_prefix text default 'CH') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.inventory_is_platform_admin() then raise exception 'Only platform administrators can create labs' using errcode = '42501'; end if;
  insert into public.inventory_labs (name, slug, barcode_prefix) values (btrim(p_name), lower(btrim(p_slug)), upper(btrim(p_prefix)))
    returning id into v_id;
  insert into public.inventory_members (lab_id, user_id, role) values (v_id, auth.uid(), 'admin');
  return v_id;
end $$;

-- Lab administrators (or platform administrators) add or change a member by e-mail. Unknown e-mails become pending invitations.
create function public.inventory_set_member(p_lab_id uuid, p_email text, p_role text) returns text
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

create function public.inventory_remove_member(p_lab_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.inventory_is_platform_admin()
          or exists (select 1 from public.inventory_members m where m.user_id = auth.uid() and m.lab_id = p_lab_id and m.role = 'admin')) then
    raise exception 'Only lab administrators can manage members' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then raise exception 'You cannot remove yourself' using errcode = '22023'; end if;
  delete from public.inventory_members where lab_id = p_lab_id and user_id = p_user_id;
  update public.inventory_user_profiles set active_lab_id = null where user_id = p_user_id and active_lab_id = p_lab_id;
  update public.inventory_user_profiles p set active_lab_id = (select m.lab_id from public.inventory_members m where m.user_id = p.user_id order by m.created_at limit 1)
    where p.user_id = p_user_id and p.active_lab_id is null;
end $$;

create function public.inventory_list_members(p_lab_id uuid) returns table (user_id uuid, full_name text, email text, role text, account_status text, pending boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.inventory_is_platform_admin()
          or exists (select 1 from public.inventory_members m where m.user_id = auth.uid() and m.lab_id = p_lab_id and m.role = 'admin')) then
    raise exception 'Only lab administrators can list members' using errcode = '42501';
  end if;
  return query
    select m.user_id, p.full_name, p.email, m.role, p.account_status, false
      from public.inventory_members m left join public.inventory_user_profiles p on p.user_id = m.user_id
      where m.lab_id = p_lab_id
    union all
    select null::uuid, null::text, pm.email, pm.role, null::text, true
      from public.inventory_pending_members pm where pm.lab_id = p_lab_id;
end $$;

-- ============================================================================
-- 7. Inventory functions called by the app (names and arguments unchanged)
-- ============================================================================
create function public.inventory_register_container_phase3(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid := public.inventory_current_lab();
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_cas text := nullif(btrim(coalesce(p ->> 'cas', '')), '');
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
  if not exists (select 1 from public.inventory_members where lab_id = v_lab and user_id = v_owner) then
    raise exception 'The owner must be a member of this lab' using errcode = '22023';
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
    insert into public.inventory_chemicals (lab_id, name, cas, formula, notes)
    values (v_lab, v_name, v_cas, nullif(btrim(coalesce(p ->> 'formula', '')), ''), nullif(btrim(coalesce(p ->> 'chemical_notes', '')), ''))
    returning id into v_chem;
  else
    update public.inventory_chemicals set formula = coalesce(formula, nullif(btrim(coalesce(p ->> 'formula', '')), '')) where id = v_chem;
  end if;

  select count(*) into v_same from public.inventory_containers
    where lab_id = v_lab and chemical_id = v_chem and location_id = v_loc and status <> 'disposed';

  insert into public.inventory_containers (lab_id, chemical_id, location_id, owner_id, container_size, remaining_amount, unit,
      supplier, catalog_number, lot_number, purity, received_at, expires_at, notes)
  values (v_lab, v_chem, v_loc, v_owner, v_size, coalesce(v_rem, v_size), coalesce(nullif(btrim(coalesce(p ->> 'unit', '')), ''), 'g'),
      nullif(btrim(coalesce(p ->> 'supplier', '')), ''), nullif(btrim(coalesce(p ->> 'catalog_number', '')), ''),
      nullif(btrim(coalesce(p ->> 'lot_number', '')), ''), nullif(btrim(coalesce(p ->> 'purity', '')), ''),
      nullif(p ->> 'received_at', '')::date, nullif(p ->> 'expires_at', '')::date, nullif(btrim(coalesce(p ->> 'notes', '')), ''))
  returning * into v_container;

  return jsonb_build_object('container_id', v_container.id, 'chemical_id', v_chem, 'barcode', v_container.barcode, 'same_location_count', v_same);
end $$;

create function public.inventory_container_action_phase3(p_id uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
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
    if not exists (select 1 from public.inventory_members m join public.inventory_user_profiles u on u.user_id = m.user_id
                   where m.lab_id = v_lab and m.user_id = v_owner and u.account_status is distinct from 'locked') then
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

create function public.inventory_delete_chemical(p_chemical_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab();
begin
  if v_lab is null or not public.inventory_is_manager() then raise exception 'Only managers can delete chemicals' using errcode = '42501'; end if;
  if not exists (select 1 from public.inventory_chemicals where id = p_chemical_id and lab_id = v_lab) then
    raise exception 'Chemical not found' using errcode = '22023';
  end if;
  if exists (select 1 from public.inventory_containers where chemical_id = p_chemical_id and lab_id = v_lab and status <> 'disposed') then
    raise exception 'Only chemicals whose containers are all disposed can be deleted' using errcode = '22023';
  end if;
  delete from public.inventory_containers where chemical_id = p_chemical_id and lab_id = v_lab;
  delete from public.inventory_chemicals where id = p_chemical_id and lab_id = v_lab;
end $$;

create function public.inventory_order_action_phase4(p_order_id uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab(); o public.inventory_orders; v_res jsonb; v_cid uuid;
begin
  if v_lab is null then raise exception 'No active lab selected' using errcode = '42501'; end if;
  select * into o from public.inventory_orders where id = p_order_id and lab_id = v_lab for update;
  if not found then raise exception 'Order not found' using errcode = '22023'; end if;

  if p_action = 'cancel' then
    if not (public.inventory_is_manager() or (o.requested_by = auth.uid() and o.status = 'requested')) then
      raise exception 'You cannot cancel this order' using errcode = '42501';
    end if;
    if o.status not in ('requested', 'ordered') then raise exception 'This order can no longer be cancelled' using errcode = '22023'; end if;
    update public.inventory_orders set status = 'cancelled' where id = o.id;
  else
    if not public.inventory_is_manager() then raise exception 'Only managers can update orders' using errcode = '42501'; end if;
    if p_action = 'ordered' then
      if o.status <> 'requested' then raise exception 'Only requested orders can be marked as ordered' using errcode = '22023'; end if;
      update public.inventory_orders set status = 'ordered', ordered_at = now() where id = o.id;
    elsif p_action = 'undo' then
      if o.status <> 'ordered' then raise exception 'Only ordered orders can be reverted' using errcode = '22023'; end if;
      update public.inventory_orders set status = 'requested', ordered_at = null where id = o.id;
    elsif p_action = 'receive' then
      if o.status not in ('requested', 'ordered') then raise exception 'This order cannot be received' using errcode = '22023'; end if;
      v_res := public.inventory_register_container_phase3(jsonb_build_object(
        'name', o.chemical_name, 'cas', o.cas, 'container_size', o.container_size, 'unit', o.unit,
        'supplier', coalesce(nullif(p ->> 'supplier', ''), o.supplier),
        'location_id', p ->> 'location_id', 'owner_id', p ->> 'owner_id',
        'received_at', p ->> 'received_at', 'expires_at', p ->> 'expires_at', 'remaining_amount', p ->> 'remaining_amount',
        'catalog_number', p ->> 'catalog_number', 'lot_number', p ->> 'lot_number', 'purity', p ->> 'purity', 'notes', p ->> 'notes'));
      v_cid := (v_res ->> 'container_id')::uuid;
      update public.inventory_orders set status = 'received', received_at = now(), received_container_id = v_cid where id = o.id;
      return v_res;
    else
      raise exception 'Unknown action %', p_action using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object('id', o.id, 'action', p_action);
end $$;

create function public.inventory_edit_order_phase5(p_order_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_lab uuid := public.inventory_current_lab(); o public.inventory_orders;
begin
  if v_lab is null or not public.inventory_is_manager() then raise exception 'Only managers can edit requests' using errcode = '42501'; end if;
  select * into o from public.inventory_orders where id = p_order_id and lab_id = v_lab for update;
  if not found then raise exception 'Order not found' using errcode = '22023'; end if;
  if o.status <> 'requested' then raise exception 'Only requested orders can be edited' using errcode = '22023'; end if;
  update public.inventory_orders set
    chemical_name = btrim(p ->> 'chemical_name'),
    cas = nullif(btrim(coalesce(p ->> 'cas', '')), ''),
    container_size = (p ->> 'container_size')::numeric,
    unit = btrim(p ->> 'unit'),
    supplier = nullif(btrim(coalesce(p ->> 'supplier', '')), ''),
    comments = nullif(btrim(coalesce(p ->> 'comments', '')), '')
  where id = o.id;
end $$;

-- ============================================================================
-- 8. Function permissions: signed-in users only (each function re-checks role and lab itself)
-- ============================================================================
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'inventory\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
-- Trigger functions never need to be called directly.
revoke execute on function public.inventory_handle_new_user() from authenticated;
revoke execute on function public.inventory_log_change() from authenticated;
revoke execute on function public.inventory_assign_container_barcode() from authenticated;
revoke execute on function public.inventory_assign_location_barcode() from authenticated;
revoke execute on function public.inventory_touch_updated_at() from authenticated;

commit;
