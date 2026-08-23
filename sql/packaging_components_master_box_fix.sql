-- ============================================================
-- Task #366 — a master box must BE a box, not merely mention one.
--
-- THE BUG
--   The master_box arm was `p_name ilike '%box%'`, so it swallowed anything
--   whose description happened to contain the word. The one that surfaced in
--   live testing:
--
--     PC-PK-0273  ALL PURPOSE GLUE STICKS (90 GLUE STICKS PER BOX)  $18.7200
--
--   filed as master_box and ranked TOP of the master-box picker, above real
--   shipper boxes. At 1/12 of a bottle that is $1.56 per bottle of glue
--   sticks — a wrong number, not a blank one, which is the failure mode this
--   whole model is built to avoid.
--
-- THE INSIGHT
--   In these Fishbowl descriptions the item's IDENTITY sits outside the
--   parentheses; what is inside is pack size or dimensions:
--
--     BOX (18 X 14 X 14)                          -> outside: "BOX"          box
--     ALTERNATIVE LABS / SHIPPER BOXES(24X12X12)  -> outside: "SHIPPER BOXES" box
--     ALL PURPOSE GLUE STICKS (90 ... PER BOX)    -> outside: "GLUE STICKS"   NOT a box
--
--   So: strip parentheticals, then look for the box words. Plus an explicit
--   guard for "per box" / "/box" / "per case" written outside brackets, which
--   is the same pack-size idea without the punctuation.
--
--   Only the master_box arm changes. Every other arm still reads the raw
--   name, so nothing else can shift underneath us.
--
-- HOW TO RUN
--   Step 1 and step 2 are SELECTs — read them before running step 3.
--   Step 3 is the only statement that writes.
-- ============================================================


-- ============================================================
-- 1. Replace the classifier
-- ============================================================
create or replace function public.packaging_component_category(
  p_name text,
  p_kind text
) returns text
language sql
immutable
as $fn$
  with n as (
    select
      coalesce(p_name, '')                                        as raw,
      -- Identity lives outside the brackets; pack size lives inside.
      regexp_replace(coalesce(p_name, ''), '\([^)]*\)', ' ', 'g') as bare
  )
  select case
    when p_kind = 'uc' and (raw ilike '%ifc%' or raw ilike '%insert%'
                            or raw ilike '%leaflet%')       then 'insert'
    when p_kind = 'uc'                                      then 'carton'

    when p_kind = 'll' and raw ilike '%band%'               then 'neckband'
    when p_kind = 'll' and raw ilike '%sleeve%'             then 'sleeve'
    when p_kind = 'll'                                      then 'label'

    when raw ilike 'NKBND%' or raw ilike '%neck band%'
         or raw ilike '%neckband%' or raw ilike '%band%'    then 'neckband'
    when raw ilike '%sleeve%'                               then 'sleeve'
    when raw ilike '%bottle%' or raw ilike '%jar%'          then 'bottle'

    -- CLOSURE BEFORE LINER. See #362: caps are described by the liner they
    -- ship with, so a liner-first rule swallowed all 20 of them.
    when raw ~* '(^|[^a-z])caps?([^a-z]|$)'
         or raw ilike '%closure%' or raw ilike '%lid%'      then 'closure'
    when raw ilike '%liner%'                                then 'liner'
    when raw ilike '%induction%' or raw ilike '%tamper%'
         or raw ilike '%safety seal%'                       then 'safety_seal'

    -- #366: box words must appear OUTSIDE any parenthetical, and must not be
    -- a "per box" pack descriptor. "master" and "shipper" are safe on the raw
    -- name — nothing is incidentally described as a master or a shipper.
    when raw ilike '%master%' or raw ilike '%shipper%'       then 'master_box'
    when (bare ilike '%box%' or bare ilike '%case%' or bare ilike '%carton%')
         and bare not ilike '%per box%'
         and bare not ilike '%per case%'
         and bare not ilike '%/box%'
         and bare not ilike '%/case%'                        then 'master_box'

    when raw ilike '%label%'                                then 'label'
    else 'other'
  end
  from n;
$fn$;

comment on function public.packaging_component_category(text, text) is
  'Classifies a packaging component into a BOM slot from its Fishbowl part-number infix and description. The master_box arm ignores parenthetical pack sizes so "90 PER BOX" no longer makes a box out of glue sticks (#366). Immutable and side-effect free.';


-- ============================================================
-- 2. PREVIEW — read this before writing anything.
--    Every row currently filed as master_box whose category would change.
-- ============================================================
select
  fp_code,
  name,
  category                                        as current_category,
  public.packaging_component_category(name, kind) as new_category,
  inventory_cost_per_unit
from public.packaging_components
where category = 'master_box'
  and public.packaging_component_category(name, kind) is distinct from 'master_box'
order by inventory_cost_per_unit desc nulls last;

-- Sanity counts: how many master_box rows now, and how many would survive.
select
  count(*) filter (where category = 'master_box')                    as master_box_now,
  count(*) filter (where public.packaging_component_category(name, kind) = 'master_box')
                                                                     as master_box_after
from public.packaging_components;


-- ============================================================
-- 3. BACKFILL — the only statement that writes.
--
--    Scoped to rows currently in master_box, so a category a human curated
--    elsewhere cannot be disturbed. A row that leaves master_box goes to
--    whatever the corrected classifier says it actually is.
-- ============================================================
update public.packaging_components
set category = public.packaging_component_category(name, kind)
where category = 'master_box'
  and public.packaging_component_category(name, kind) is distinct from 'master_box';


-- ============================================================
-- 4. VERIFY — glue sticks gone, real boxes intact.
-- ============================================================
select fp_code, name, category, inventory_cost_per_unit
from public.packaging_components
where category = 'master_box'
order by inventory_cost_per_unit desc nulls last
limit 25;
