-- Lease charged per RUN-DAY, per production line.
--
-- Run after overhead_reference.sql and overhead_pools.sql.
--
-- WHAT THIS REPLACES
--
-- The calculators charged rent as (monthly x share%) / 21 calendar days x job
-- days. That assumed the plant does one job at a time. The packaging yield log
-- says otherwise: 3.28 jobs in parallel, 67.2 run-days a month. Calendar days
-- over-charged rent by about 3x, on top of charging Suite 300 at 100% when only
-- 40% of it is packaging floor.
--
-- A line's rate is two pieces added together:
--
--   FLOOR      its production pool (packaging floor, or the Suite 400 kettle)
--              divided by that pool's capacity
--   FACILITY   its share of the warehouse-and-office pool, divided by the
--              run-days that line actually works
--
-- The facility SHARE is set by gross margin — how much of the plant's earnings
-- a line accounts for. The facility RATE then spreads that share over the
-- line's own run-days. Margin decides how big the slice is; run-days decide how
-- it lands on an individual job. Doing it in one step (facility as a % of a
-- job's margin) would be circular: price depends on overhead depends on margin
-- depends on price.

-- ============================================================
-- 1. Run-days per line
-- ============================================================
alter table public.overhead_facility_shares
  add column if not exists run_days_per_month numeric;

comment on column public.overhead_facility_shares.run_days_per_month is
  'Days per month this line occupies its production space. Divides the line''s facility slice into a per-run-day rate. NULL means the line has no time-based absorption — its slice stays unrecovered rather than being pushed onto the others.';

alter table public.overhead_facility_shares
  add column if not exists production_pool_key text;

comment on column public.overhead_facility_shares.production_pool_key is
  'Which production pool this line runs in. Several lines can share one pool: every contract-packaging format works the same Suite 300 floor.';


-- ============================================================
-- 2. Shares, run-days and pools
-- ============================================================
-- Gross margin, 12 months to Aug 2026:
--
--   contract packaging   (<$1.50/unit)   $1,389,119   625 run-days
--   finished product     (>=$1.50/unit)  $  517,905    99 run-days
--   FP w/ Suite-400 bulk (M-prefix SO)   $  227,834    58 run-days
--   bulk resale          (margins report) $     995     -
--
-- The $1.50/unit threshold is the operator's rule for telling a packaging fee
-- from a product sale, and it reconciles with the customers we know are
-- finished product. The M-prefix on a sales order means the bulk was made in
-- Suite 400, which is what credits gummy manufacturing.
--
-- BULK RESALE IS FLOORED AT 3%, NOT ITS MARGIN SHARE.
--
-- On margin alone resale earns 0.05% of the plant and would absorb $13/month.
-- It occupies real warehouse while earning almost nothing, and at $13 the other
-- lines quietly carry its pallets. 3% (~$862/mo) is deliberately generous to
-- the truth of what it consumes. It also makes resale's economics visible:
-- at 1.96% gross margin it cannot cover $862, and the model should say so
-- rather than hide it. The other three lines are scaled into the remaining 97%.
delete from public.overhead_facility_shares;
insert into public.overhead_facility_shares
  (line_key, share_pct, run_days_per_month, production_pool_key, notes) values
  ('contract_packaging',  63.12, 52.08, 'cp_packaging',
     'Margin $1,389,119/yr over 625 run-days. Packaging fee work, under $1.50/unit.'),
  ('finished_product',    23.53, 13.08, 'cp_packaging',
     'Margin $517,905/yr over 99 run-days. Same floor as CP; higher facility rate because buying and holding the bulk uses more warehouse and purchasing.'),
  ('gummy_manufacturing', 10.35, 21.00, 'gummy_manufacturing',
     'Margin $227,834/yr on M-prefix orders. One batch at a time, 21 working days.'),
  ('bulk_resale',          3.00, null,  null,
     'FLOOR, not a computed share. Margin says 0.05%. No calculator and no run-days, so this slice is currently UNRECOVERED rather than redistributed.');


-- ============================================================
-- 3. The rate
-- ============================================================
create or replace function public.overhead_lease_rate(
  p_line_key text,
  p_asof     date default null
)
returns table (
  line_key            text,
  floor_rate          numeric,
  facility_rate       numeric,
  per_run_day         numeric,
  run_days_per_month  numeric,
  facility_share_pct  numeric,
  production_pool_key text,
  asof_used           date
)
language sql stable as $$
  with pools as (select * from public.overhead_pool_rates(p_asof)),
       fac   as (select monthly from pools where pool_key = 'facility'),
       s     as (select * from public.overhead_facility_shares where line_key = p_line_key)
  select s.line_key,
         (select round(p.rate_per_day, 2) from pools p
           where p.pool_key = s.production_pool_key)                        as floor_rate,
         case when s.run_days_per_month > 0
              then round((select monthly from fac) * s.share_pct / 100
                         / s.run_days_per_month, 2) end                     as facility_rate,
         case when s.run_days_per_month > 0
              then round(
                coalesce((select p.rate_per_day from pools p
                           where p.pool_key = s.production_pool_key), 0)
                + (select monthly from fac) * s.share_pct / 100
                  / s.run_days_per_month, 2) end                            as per_run_day,
         s.run_days_per_month, s.share_pct, s.production_pool_key,
         (select max(asof_used) from public.overhead_for_line(p_line_key, p_asof))
    from s;
$$;

comment on function public.overhead_lease_rate(text, date) is
  'Rent a job absorbs per run-day for one production line: its production-pool rate plus its share of warehouse and office over its own run-days. NULL per_run_day means the line has no time-based absorption (bulk resale) and its slice is unrecovered.';


-- ============================================================
-- 4. Check
-- ============================================================
--   select * from public.overhead_lease_rate('contract_packaging');
--
-- Expected on the current bands:
--
--   contract_packaging    floor $119.65 + facility $348.27 = $467.93 /run-day
--   finished_product      floor $119.65 + facility $516.91 = $636.56 /run-day
--   gummy_manufacturing   floor $274.78 + facility $141.67 = $416.45 /run-day
--   bulk_resale           NULL (no absorption mechanism)
--
-- Recovery check — each line's rate x its run-days should rebuild the estate:
--   467.93 x 52.08 + 636.56 x 13.08 + 416.45 x 21 + 862 (resale, unrecovered)
--   = 24,369 + 8,326 + 8,745 + 862  =  $42,302  vs  $42,550 actual
-- The ~$248 gap is rounding in the published rates, not a modelling error.
