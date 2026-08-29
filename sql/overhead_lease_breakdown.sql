-- Per-suite lease breakdown for a production line's costing board.
--
-- Run after overhead_reference.sql, overhead_pools.sql and
-- overhead_lease_rate.sql.
--
-- WHY THIS EXISTS
--
-- overhead_lease_rate() answers "what does a run-day cost this line?" in one
-- number. That number is correct but unexplainable on a screen: the board
-- showed $467.97 with no visible path from the three leases to it, and a
-- figure nobody can trace is a figure nobody trusts (the gummy tab earns its
-- trust by showing Base + CAM -> Share % -> Allocated -> per piece on one
-- line).
--
-- This function returns the same arithmetic EXPLODED: one row per
-- (suite x pool) with the suite's rent apportioned by floor area, the line's
-- share applied where the pool is margin-driven, and the divisor named. Every
-- row is a single division a person can check by hand:
--
--   Suite 300 / packaging floor   8,040.80 / 67.2  = 119.65
--   Suite 300 / wh+office         7,613.02 / 52.08 = 146.18
--   Suite 500/600 / wh+office    10,527.24 / 52.08 = 202.14
--                                                    ------
--                                                    467.97  = lease_rate()
--
-- Rows that charge this line nothing (Suite 400 for contract packaging) are
-- RETURNED, not filtered — a visible zero with the pool named is the answer to
-- "why isn't this suite in my price?", and hiding it just moves that question
-- to a phone call.

create or replace function public.overhead_lease_breakdown(
  p_line_key text,
  p_asof     date default null
)
returns table (
  item_key          text,
  suite_label       text,
  pool_key          text,
  pool_label        text,
  sq_ft             numeric,
  pct_of_suite      numeric,
  base_monthly      numeric,
  cam_monthly       numeric,
  charged_monthly   numeric,
  divisor_days      numeric,
  rate_per_day      numeric,
  share_pct_applied numeric,
  sort_order        integer
)
language sql stable as $$
  with s as (
    select production_pool_key, share_pct, run_days_per_month
    from public.overhead_facility_shares
    where line_key = p_line_key
  ),
  rent as (
    -- Rent rows in force on the as-of date. Same date resolution as
    -- everything else: overhead_for_line() owns the banding.
    select r.item_key, r.label, r.monthly as base, coalesce(r.cam, 0) as cam,
           r.sort_order,
           (select sum(f.sq_ft) from public.overhead_space_functions f
             where f.item_key = r.item_key) as suite_sq_ft
    from public.overhead_for_line(p_line_key, p_asof) r
    where r.group_key = 'rent'
  ),
  parts as (
    -- A suite may feed one pool from several functions (warehouse + office
    -- both land in facility); collapse to one row per suite x pool so the
    -- board shows "wh + office" once, not twice.
    select rent.item_key, rent.label, f.pool_key,
           sum(f.sq_ft) as sq_ft,
           rent.suite_sq_ft, rent.base, rent.cam, rent.sort_order
    from rent
    join public.overhead_space_functions f on f.item_key = rent.item_key
    group by rent.item_key, rent.label, f.pool_key,
             rent.suite_sq_ft, rent.base, rent.cam, rent.sort_order
  ),
  calc as (
    select p.item_key, p.label as suite_label, p.pool_key,
           pl.label as pool_label, p.sq_ft,
           p.sq_ft / nullif(p.suite_sq_ft, 0) as frac,
           p.base, p.cam, p.sort_order,
           pl.absorption, pl.capacity_per_month
    from parts p
    join public.overhead_pools pl on pl.pool_key = p.pool_key
  )
  select c.item_key, c.suite_label, c.pool_key, c.pool_label,
         c.sq_ft,
         round(c.frac * 100, 1)          as pct_of_suite,
         round(c.base * c.frac, 2)       as base_monthly,
         round(c.cam  * c.frac, 2)       as cam_monthly,
         -- The line's monthly slice of this row. Three cases:
         --   its own production pool  -> the full apportioned amount
         --   the margin-driven pool   -> apportioned x the line's share
         --   another line's pool      -> 0, visibly
         case
           when c.pool_key = (select production_pool_key from s)
             then round((c.base + c.cam) * c.frac, 2)
           when c.absorption = 'margin'
             then round((c.base + c.cam) * c.frac
                        * (select share_pct from s) / 100, 2)
           else 0
         end as charged_monthly,
         case
           when c.pool_key = (select production_pool_key from s)
             then c.capacity_per_month
           when c.absorption = 'margin'
             then (select run_days_per_month from s)
           else null
         end as divisor_days,
         case
           when c.pool_key = (select production_pool_key from s)
                and c.capacity_per_month > 0
             then round((c.base + c.cam) * c.frac / c.capacity_per_month, 2)
           when c.absorption = 'margin'
                and (select run_days_per_month from s) > 0
             then round((c.base + c.cam) * c.frac
                        * (select share_pct from s) / 100
                        / (select run_days_per_month from s), 2)
           else 0
         end as rate_per_day,
         case when c.absorption = 'margin'
              then (select share_pct from s) end as share_pct_applied,
         c.sort_order
  from calc c
  order by c.sort_order, c.pool_key;
$$;

comment on function public.overhead_lease_breakdown(text, date) is
'One row per suite x pool: the suite''s rent apportioned by floor area, the line''s slice of it, and the per-run-day rate. The rate_per_day column sums to overhead_lease_rate().per_run_day for the same line and date — this is that number, exploded so a person can check it.';

-- ============================================================
-- Check after running
-- ============================================================
--   select * from public.overhead_lease_breakdown('contract_packaging');
--
-- Expected on the current bands (sums to lease_rate 467.97):
--
--   suite_300      cp_packaging  4,288 ft²  charged  8,040.80 /67.2  = 119.65
--   suite_300      facility      6,432 ft²  charged  7,613.02 /52.08 = 146.18
--   suite_400      gummy_manuf.  3,072 ft²  charged      0.00          0.00
--   suite_500_600  facility      8,879 ft²  charged 10,527.24 /52.08 = 202.14
