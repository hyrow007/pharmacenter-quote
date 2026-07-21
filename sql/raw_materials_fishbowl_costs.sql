-- v57: Fishbowl cost sources for the Costing tab.
--
-- The nightly server sync (C:\pharmacenter-sync\fishbowl-sync.mjs) now
-- extracts two costs per PC-RW part from the Fishbowl backup dump:
--   inventory_cost_per_kg  — latest partcost.avgCost (inventory average)
--   last_order_cost_per_kg — newest poitem.unitCost (last price paid on
--                            a purchase order)
-- and POSTs them to /api/sync/raw-materials alongside the existing
-- fields. These columns receive them; the Costing tab's "Fish Bowl
-- (Inventory)" and "Fish Bowl (Last Order)" sources read them.

alter table public.raw_materials
  add column if not exists inventory_cost_per_kg numeric;
alter table public.raw_materials
  add column if not exists last_order_cost_per_kg numeric;

comment on column public.raw_materials.inventory_cost_per_kg is
  'Fishbowl inventory average cost (partcost.avgCost), refreshed by the nightly sync.';
comment on column public.raw_materials.last_order_cost_per_kg is
  'Last price paid on a Fishbowl purchase order (newest poitem.unitCost), refreshed by the nightly sync.';
