-- Activity History: Substance and Container are one thing to the user, so adding a container no longer shows two rows.
-- Adding a container with a new substance writes two log rows in one transaction (a Substance Creation and a Container
-- Creation with the same timestamp and user). The substance row is now hidden when it only repeats a container row.
-- Nothing is deleted: the audit rows stay in inventory_activity_logs. Edits to a substance's details are still listed
-- (the app labels them Container). Run once in the Supabase SQL editor. Safe to run again. Works with the previous app version.

-- 1. Activity History & Auditing page (same signature and permissions as sql/13)
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
       and not (l.table_name = 'inventory_chemicals' and l.action in ('insert', 'delete')
                and exists (select 1 from public.inventory_activity_logs k
                             where k.lab_id = l.lab_id and k.table_name = 'inventory_containers'
                               and k.action = l.action and k.created_at = l.created_at
                               and k.performed_by is not distinct from l.performed_by))
     order by l.created_at desc
     limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
end $$;
revoke all on function public.inventory_history_page(date, date, integer) from public, anon;
grant execute on function public.inventory_history_page(date, date, integer) to authenticated;

-- 2. Account drawer summary (same as sql/17, with the same duplicate hidden from "recent")
create or replace function public.inventory_my_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lab uuid := public.inventory_current_lab();
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if v_lab is null then
    return jsonb_build_object('requested', 0, 'ordered', 0, 'active_containers', 0, 'recent', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'requested', (select count(*) from public.inventory_orders o where o.lab_id = v_lab and o.requested_by = v_uid),
    'ordered', (select count(*) from public.inventory_orders o where o.lab_id = v_lab and o.requested_by = v_uid and o.status in ('ordered', 'received')),
    'active_containers', (select count(*) from public.inventory_containers c
                           where c.lab_id = v_lab and coalesce(c.status, '') <> 'disposed'
                             and c.id in (select o.received_container_id from public.inventory_orders o
                                           where o.lab_id = v_lab and o.requested_by = v_uid and o.received_container_id is not null)),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('created_at', x.created_at, 'description', x.description) order by x.created_at desc)
                          from (select l.created_at, l.description from public.inventory_activity_logs l
                                 where l.lab_id = v_lab and l.performed_by = v_uid and l.description is not null
                                   and not (l.table_name = 'inventory_chemicals' and l.action in ('insert', 'delete')
                                            and exists (select 1 from public.inventory_activity_logs k
                                                         where k.lab_id = l.lab_id and k.table_name = 'inventory_containers'
                                                           and k.action = l.action and k.created_at = l.created_at
                                                           and k.performed_by is not distinct from l.performed_by))
                                 order by l.created_at desc limit 3) x), '[]'::jsonb)
  );
end $$;
revoke all on function public.inventory_my_summary() from public, anon;
grant execute on function public.inventory_my_summary() to authenticated;
