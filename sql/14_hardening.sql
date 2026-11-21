-- Defence in depth (no behaviour change): take away table and function permissions the app never uses.
-- Row-level security still decides which rows a signed-in person can see or change; this removes the
-- permissions underneath it, so a future mistake in a policy cannot open a door by itself.
-- Run once in the Supabase SQL editor. Safe to run again. Nothing here changes what the app can do.

-- 1. Signed-out visitors (role "anon") get no access to any table. The app only reads data after sign-in.
revoke all on all tables in schema public from anon;

-- 2. Signed-in users keep SELECT on every table (row-level security limits the rows) but lose write permissions,
--    except the few direct writes the app really makes. Every other change goes through the checked database functions.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
grant insert, update on public.inventory_locations to authenticated;  -- add / edit a location (administrators, by policy)
grant update on public.inventory_chemicals to authenticated;          -- edit chemical details (managers, by policy)
grant update on public.inventory_containers to authenticated;         -- edit container details (managers, by policy)
grant insert on public.inventory_orders to authenticated;             -- request an order (own request only, by policy)

-- 3. Trigger helper functions are never called directly, so nobody needs permission to execute them.
do $$ declare f text; begin
  foreach f in array array['public.inventory_guard_members()', 'public.inventory_guard_location_type()', 'public.rls_auto_enable()'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;
