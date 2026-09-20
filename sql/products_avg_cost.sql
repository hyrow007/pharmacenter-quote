-- products.avg_cost — Fishbowl inventory average cost for the product's
-- linked part (product.partId → latest partcost.avgCost, per unit in the
-- part's base UOM).
--
-- Populated by the nightly Fishbowl sync via POST /api/sync/product-costs
-- (quote app). Consumed by the PricingCalculator: when a workflow product
-- with Source = "Existing stock" is picked, Cost per unit pre-fills with
-- this value (the landed cost already sitting in Fishbowl).
--
-- Run in the Supabase SQL Editor.

alter table public.products
  add column if not exists avg_cost numeric;

comment on column public.products.avg_cost is
  'Fishbowl inventory average cost per unit (latest partcost.avgCost for the product''s part). Synced nightly; null = no cost history in Fishbowl.';
