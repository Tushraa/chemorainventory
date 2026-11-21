-- Account drawer summary for the signed-in user (their own numbers only), in one call:
--   requested         = order requests the user made
--   ordered           = of those, how many a manager marked ordered (including received)
--   active_containers = containers that came from the user's orders and are still in the database (not disposed)
--   recent            = the user's last three actions (from Activity History & Auditing, only their own rows)
-- Run once in the Supabase SQL editor. Safe to run again. The app hides the section until this is run.
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
                                 order by l.created_at desc limit 3) x), '[]'::jsonb)
  );
end $$;
revoke all on function public.inventory_my_summary() from public, anon;
grant execute on function public.inventory_my_summary() to authenticated;
