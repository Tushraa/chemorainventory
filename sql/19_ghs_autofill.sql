-- Automatic hazard codes: the app looks up a chemical's GHS hazard statements on PubChem and saves them,
-- so every chemical (and every printed label) carries hazard information without anyone having to enter it.
-- Any member of the lab may trigger the fill, but it ONLY fills a chemical that has no hazard codes yet.
-- It never overwrites codes that are already stored (for example codes a manager edited by hand).
-- Run once in the Supabase SQL editor. Safe to run again. Without it, only managers' browsers can save the filled codes.
create or replace function public.inventory_autofill_ghs(p_chemical_id uuid, p_codes text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid := public.inventory_current_lab();
  v_cur text[];
  v_new text[];
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if v_lab is null then raise exception 'No laboratory selected' using errcode = '42501'; end if;
  select ghs_codes into v_cur from public.inventory_chemicals where id = p_chemical_id and lab_id = v_lab;
  if not found then raise exception 'Chemical not found' using errcode = 'P0002'; end if;
  select coalesce(array_agg(distinct upper(btrim(x))) filter (where upper(btrim(x)) ~ '^(H|EUH)[0-9]{3}[A-Za-z]{0,3}$'), '{}') into v_new
    from unnest(coalesce(p_codes, '{}')) x;
  if coalesce(cardinality(v_cur), 0) > 0 or cardinality(v_new) = 0 then return v_cur; end if;
  update public.inventory_chemicals set ghs_codes = v_new
    where id = p_chemical_id and lab_id = v_lab and coalesce(cardinality(ghs_codes), 0) = 0;
  return v_new;
end $$;
revoke all on function public.inventory_autofill_ghs(uuid, text[]) from public, anon;
grant execute on function public.inventory_autofill_ghs(uuid, text[]) to authenticated;
