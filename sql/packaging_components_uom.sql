-- packaging_components: separate PURCHASE cost from PER-EACH cost.
--
-- WHY THIS EXISTS
--
-- The first sync landed 1927 rows and every cost looked wrong by orders of
-- magnitude: a double-wall box at $7,461.69, a master carton at $3,300.00.
-- Those are not per-box prices. Fishbowl prices most packaging in the UOM
-- "un", which at PharmaCenter means a THOUSAND eaches. So $7,461.69/un is
-- $7.46 per box, and the 672 "un" rows whose costs averaged $292.10 are
-- really averaging $0.2921 per piece — exactly where packaging should sit.
--
-- This is the same class of bug raw_materials solved with lb -> kg, and it
-- is more dangerous here: a wrong-by-1000x cost is a PRESENT value, so the
-- costing model's null-propagation rule never fires. The line does not go
-- blank, it just silently quotes a number 1000x too high.
--
-- THE MODEL
--
--   inventory_cost_per_purchase_unit  what Fishbowl actually reported
--   inventory_cost_uom                the UOM it was reported in ("un")
--   units_per_purchase_unit           eaches inside one of those (1000)
--   inventory_cost_per_unit           the true PER-EACH cost (derived)
--
-- Keeping the raw purchase cost means the conversion is always auditable:
-- the admin UI can show "un @ $292.10 / 1000 = $0.2921 ea" instead of a
-- bare number nobody can check.
--
-- UNCONVERTIBLE ROWS
--
-- 95 PharmaCenter rows arrive in UOMs with no defensible each-count:
-- kg (70), mm (19), lbs (5), hr (1). You cannot derive "how many bottles"
-- from a kilogram. For those the sync stores the raw purchase cost and
-- leaves units_per_purchase_unit NULL, which leaves the per-each cost NULL
-- -- so null-propagation correctly blanks the line rather than guessing.
-- An admin resolves them by setting units_per_purchase_unit_override.
--
-- Run me in the Supabase SQL Editor, then re-run the Fishbowl sync.

-- ============================================================
-- 1. Columns
-- ============================================================
alter table public.packaging_components
  add column if not exists inventory_cost_per_purchase_unit  numeric,
  add column if not exists last_order_cost_per_purchase_unit numeric,
  add column if not exists units_per_purchase_unit           numeric
    check (units_per_purchase_unit is null or units_per_purchase_unit > 0),
  -- App-owned overlay. Never written by the sync. Set this to rescue a row
  -- whose Fishbowl UOM carries no automatic conversion.
  add column if not exists units_per_purchase_unit_override  numeric
    check (units_per_purchase_unit_override is null
           or units_per_purchase_unit_override > 0);

comment on column public.packaging_components.inventory_cost_per_purchase_unit is
  'Fishbowl avgCost exactly as reported, denominated in inventory_cost_uom. Never divided. Kept so the per-each conversion stays auditable.';
comment on column public.packaging_components.units_per_purchase_unit is
  'Eaches inside one purchase UOM. 1000 for "un", 1 for "ea". NULL means Fishbowl reported a UOM with no defensible each-count (kg, lbs, mm, hr) -- the per-each cost is then NULL by design.';
comment on column public.packaging_components.units_per_purchase_unit_override is
  'Admin-set. Wins over units_per_purchase_unit. The way to resolve a row the sync could not convert. Sync never touches this column.';
comment on column public.packaging_components.inventory_cost_per_unit is
  'TRUE COST PER EACH, derived: cost_per_purchase_unit / units_per_purchase_unit. Forced to 0 when owner = customer. NULL when the UOM could not be converted -- treat NULL as unresolved and blank the costing line.';

-- ============================================================
-- 2. Effective per-each view
--
-- Applies the admin override on read so callers never have to remember the
-- coalesce. A customer asset stays a hard 0: that zero is a KNOWN value,
-- not a missing one, and must contribute $0 without blanking the line.
-- ============================================================
create or replace view public.packaging_components_costed as
select
  pc.*,
  coalesce(pc.units_per_purchase_unit_override, pc.units_per_purchase_unit)
    as effective_units_per_purchase_unit,
  case
    when pc.owner = 'customer' then 0
    when pc.inventory_cost_per_purchase_unit is null then null
    when coalesce(pc.units_per_purchase_unit_override,
                  pc.units_per_purchase_unit) is null then null
    else pc.inventory_cost_per_purchase_unit
         / coalesce(pc.units_per_purchase_unit_override,
                    pc.units_per_purchase_unit)
  end as effective_cost_per_unit,
  -- Lets the UI flag the two failure modes distinctly instead of showing a
  -- bare blank: "no cost in Fishbowl" vs "cost exists but UOM unconvertible".
  case
    when pc.owner = 'customer'                            then 'customer_asset'
    when pc.inventory_cost_per_purchase_unit is null      then 'no_cost'
    when pc.inventory_cost_per_purchase_unit = 0          then 'zero_cost'
    when coalesce(pc.units_per_purchase_unit_override,
                  pc.units_per_purchase_unit) is null     then 'uom_unresolved'
    else 'ok'
  end as cost_status
from public.packaging_components pc;

comment on view public.packaging_components_costed is
  'packaging_components with the admin override applied. cost_status distinguishes a customer-asset zero (known) from a missing cost, a suspicious Fishbowl zero, and an unconvertible UOM.';

-- ============================================================
-- 3. Backfill note
--
-- No UPDATE here on purpose. The existing 1927 rows carry per-EACH values
-- that are actually per-PURCHASE-UNIT, and there is no way to tell from
-- inside the database which is which. Re-running the Fishbowl sync after
-- deploying the updated /api/sync/packaging-components route rewrites every
-- row correctly in one pass. Do that instead of guessing here.
-- ============================================================
