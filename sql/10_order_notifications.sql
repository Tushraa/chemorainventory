-- Order e-mail notifications (sent by the "inventory-notify" edge function through Resend).
-- Run once in the Supabase SQL editor. Safe to run again.

-- 1. Who is e-mailed about order activity in a lab (set by lab managers in Order Settings) --------------------------
create table if not exists public.inventory_order_recipients (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references public.inventory_labs (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254),
  created_at timestamptz not null default now(),
  unique (lab_id, email)
);
create index if not exists inventory_order_recipients_lab_idx on public.inventory_order_recipients (lab_id);

alter table public.inventory_order_recipients enable row level security;
drop policy if exists order_recipients_select on public.inventory_order_recipients;
create policy order_recipients_select on public.inventory_order_recipients for select to authenticated
  using (lab_id = (select public.inventory_current_lab()) and (select public.inventory_is_manager()));
-- No insert/update/delete policies: changes go through inventory_set_order_recipients below.

-- Replace the whole list in one step. Managers of the current lab only; at most 20 addresses.
create or replace function public.inventory_set_order_recipients(p_emails text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid := public.inventory_current_lab();
  v_clean text[];
  v_bad text;
begin
  if auth.uid() is null or v_lab is null or not public.inventory_is_manager() then
    raise exception 'Only chemical managers and administrators can change order settings' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct e), '{}') into v_clean
    from (select lower(btrim(x)) as e from unnest(coalesce(p_emails, '{}')) x where btrim(x) <> '') s;
  if cardinality(v_clean) > 20 then
    raise exception 'Add at most 20 recipient addresses' using errcode = '22023';
  end if;
  select e into v_bad from unnest(v_clean) e
   where e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 limit 1;
  if v_bad is not null then
    raise exception 'Not a valid e-mail address: %', v_bad using errcode = '22023';
  end if;
  delete from public.inventory_order_recipients where lab_id = v_lab and not (email = any (v_clean));
  insert into public.inventory_order_recipients (lab_id, email)
    select v_lab, e from unnest(v_clean) e on conflict (lab_id, email) do nothing;
  return cardinality(v_clean);
end $$;
revoke all on function public.inventory_set_order_recipients(text[]) from public, anon;
grant execute on function public.inventory_set_order_recipients(text[]) to authenticated;

-- 2. One e-mail per order event: the edge function records each send here so repeated calls cannot spam ----------------
create table if not exists public.inventory_order_notifications (
  order_id uuid not null references public.inventory_orders (id) on delete cascade,
  event text not null check (event in ('requested', 'ordered', 'received', 'cancelled')),
  stamp text not null,
  sent_at timestamptz not null default now(),
  primary key (order_id, event, stamp)
);
alter table public.inventory_order_notifications enable row level security;
-- No policies: only the edge function (service role) reads or writes this table.
