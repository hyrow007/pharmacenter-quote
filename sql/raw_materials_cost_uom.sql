-- v57.1: UOM-conversion indicator for the Costing tab.
--
-- The server sync converts Fishbowl costs to $/kg (partcost.avgCost is
-- per the part's base UOM; poitem.unitCost per the PO line UOM). These
-- columns record the source UOM each cost was converted FROM so the UI
-- can show a "lb → kg" tag. "kg" or null = no conversion happened.

alter table public.raw_materials
  add column if not exists inventory_cost_uom text;
alter table public.raw_materials
  add column if not exists last_order_cost_uom text;

comment on column public.raw_materials.inventory_cost_uom is
  'Fishbowl base UOM the inventory average cost was converted from (e.g. lb). kg/null = no conversion.';
comment on column public.raw_materials.last_order_cost_uom is
  'UOM the last-PO cost was converted from (e.g. lb). kg/null = no conversion.';
