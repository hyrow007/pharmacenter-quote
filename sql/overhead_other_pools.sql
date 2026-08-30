-- Other expenses by POOL — the last calendar-day holdout joins the model.
--
-- Run after overhead_indirect_pools.sql.
--
-- Same question as the lease and the people: what does each expense SERVE?
-- Decisions 2026-08-30:
--
--   production days   Electricity (machines dominate the load; the office
--                     share is a simplification accepted rather than an
--                     unmeasured split), Repairs & Maintenance (mostly
--                     machine work). Divide by all plant production days at
--                     equal weight, like the production-support people.
--
--   facility          Insurance, Licenses & Permits, Cleaning (janitorial,
--                     whole building), Warehouse Supplies & Tools, Other
--                     Utilities. Serve the entire operation including
--                     floorless resale, so the line's margin share applies.
--
-- Result on current figures: ~$65.48 + ~$111.50 = ~$176.98 per CP run-day,
-- versus ~$395 per job-day under the old 30/40% shares over 21 calendar
-- days. This card was the most over-charged of the three because none of it
-- had the parallel-runs correction.

-- ============================================================
-- 1. Pool label — production_support now holds expenses too
-- ============================================================
update public.overhead_pools
   set label = 'Production support',
       notes = 'People and expenses that run with production days on both floors, at equal weight per the 2026-08-30 decision. Divisor derived at query time as cp_packaging + gummy_manufacturing capacities (currently 88.2).'
 where pool_key = 'production_support';

-- ============================================================
-- 2. Expense -> pool
-- ============================================================
delete from public.overhead_item_pools
 where item_key in ('electricity','warehouse_supplies','licenses_permits',
                    'insurance','repairs_maintenance','cleaning','other_utilities');
insert into public.overhead_item_pools (item_key, pool_key, notes) values
  ('electricity',         'production_support', 'Machines dominate the load. Office lights ride along as an accepted simplification — split it only if someone meters it.'),
  ('repairs_maintenance', 'production_support', 'Mostly machine work. Re-pool to facility if the QB account turns out to be building repairs.'),
  ('warehouse_supplies',  'facility', 'Consumed moving goods for the entire operation.'),
  ('insurance',           'facility', 'Covers the entire operation.'),
  ('licenses_permits',    'facility', 'Licenses the entire operation.'),
  ('cleaning',            'facility', 'Janitorial for the whole building. Line cleaning is already in direct labor per job.'),
  ('other_utilities',     'facility', 'Serves the entire operation.');

-- ============================================================
-- 3. Resolver — same shape as the indirect breakdown
-- ============================================================
create or replace function public.overhead_other_breakdown(
  p_line_key text,
  p_asof     date default null
)
returns table (
  item_key          text,
  expense_label     text,
  qb_account        text,
  pool_key          text,
  pool_label        text,
  monthly           numeric,
  charged_monthly   numeric,
  divisor_days      numeric,
  rate_per_day      numeric,
  share_pct_applied numeric,
  sort_order        integer
)
language sql stable as $$
  with s as (
    select share_pct, run_days_per_month
    from public.overhead_facility_shares
    where line_key = p_line_key
  ),
  plant_days as (
    select sum(capacity_per_month) as days
    from public.overhead_pools
    where pool_key in ('cp_packaging','gummy_manufacturing')
  ),
  rows_ as (
    select r.item_key, r.label, r.qb_account, r.sort_order,
           coalesce(r.monthly, 0) as monthly
    from public.overhead_for_line(p_line_key, p_asof) r
    where r.group_key = 'other'
  )
  select rw.item_key, rw.label, rw.qb_account, ip.pool_key, pl.label,
         round(rw.monthly, 2) as monthly,
         case
           when ip.pool_key = 'production_support' then round(rw.monthly, 2)
           when ip.pool_key = 'facility'
             then round(rw.monthly * (select share_pct from s) / 100, 2)
           else 0
         end as charged_monthly,
         case
           when ip.pool_key = 'production_support' then (select days from plant_days)
           when ip.pool_key = 'facility' then (select run_days_per_month from s)
         end as divisor_days,
         case
           when ip.pool_key = 'production_support'
                and (select days from plant_days) > 0
             then round(rw.monthly / (select days from plant_days), 2)
           when ip.pool_key = 'facility'
                and (select run_days_per_month from s) > 0
             then round(rw.monthly * (select share_pct from s) / 100
                        / (select run_days_per_month from s), 2)
           else 0
         end as rate_per_day,
         case when ip.pool_key = 'facility'
              then (select share_pct from s) end as share_pct_applied,
         rw.sort_order
  from rows_ rw
  join public.overhead_item_pools ip on ip.item_key = rw.item_key
  join public.overhead_pools pl on pl.pool_key = ip.pool_key
  order by case ip.pool_key when 'production_support' then 0 else 1 end,
           rw.sort_order;
$$;

comment on function public.overhead_other_breakdown(text, date) is
'One row per other-expense line: monthly, the line''s slice, and a per-run-day rate summing to what a job absorbs per occupancy day. An expense missing from overhead_item_pools is excluded by the join — deliberately loud, same as the indirect resolver.';

-- ============================================================
-- 4. Check after running
-- ============================================================
--   select * from public.overhead_other_breakdown('contract_packaging');
--
-- Expected on the current bands:
--
--   electricity           4,497 /88.2           = 50.99
--   repairs_maintenance   1,278 /88.2           = 14.49
--   warehouse_supplies    2,525 x63.12% /52.08  = 30.60
--   insurance             3,281 x63.12% /52.08  = 39.77
--   licenses_permits      2,428 x63.12% /52.08  = 29.43
--   cleaning                675 x63.12% /52.08  =  8.18
--   other_utilities         291 x63.12% /52.08  =  3.53
--                                                 ------
--                                                 176.99 per run-day
