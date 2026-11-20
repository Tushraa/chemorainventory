-- Each order request records whether the requester wants email updates about it (ordered / received / cancelled).
-- Run once in the Supabase SQL editor. Safe to run again. Existing orders stay "no".
alter table public.inventory_orders add column if not exists notify_requester boolean not null default false;
