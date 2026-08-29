-- Overhead pools — allocate the plant by FUNCTION, not by suite.
--
-- Companion to sql/overhead_reference.sql. Run that one first.
--
-- WHY
--
-- The first cut charged whole suites to whole production lines: Suite 300 100%
-- to bottling, Suite 400 100% to gummy. Three things were wrong with that.
--
--   1. Suite 300 is only 40% packaging. The rest is warehouse and office, and
--      charging it all to one line made bottling pay for both.
--   2. Suite 300 belongs to the whole Contract Packaging DEPARTMENT — bottles,
--      blisters, sachets, pouches, kitting — not to bottling alone. Five more
--      calculators are coming.
--   3. The allocation divided by CALENDAR days, which assumes the plant does
--      one job at a time. Measured from the yield log, it runs 3.28 jobs in
--      parallel and 67.2 run-days a month.
--
-- Nothing here restates a lease. overhead_items still holds the rent facts,
-- effective-dated and sourced from the amendments. This file apportions each
-- suite into FUNCTIONS by floor area, groups those into POOLS, and gives each
-- pool its own absorption rule. Cost per square foot is uniform across the
-- estate ($1.8752 / $1.8784), so floor area is a faithful splitter.
--
-- ADDITIVE AND SAFE. It creates new tables and adds new share rows; it changes
-- no existing row and drops nothing. The live overhead_for_line() keeps working
-- exactly as before, so running this cannot move a quoted number. Wiring the
-- calculators to the pools is a separate, later step.


-- ============================================================
-- 1. Space functions — how each suite's floor area is used
-- ============================================================
create table if not exists public.overhead_space_functions (
  item_key   text not null,      -- matches overhead_items.item_key (a suite)
  function   text not null,      -- packaging / manufacturing / warehouse / office
  sq_ft      numeric not null check (sq_ft >= 0),
  pool_key   text not null,
  notes      text,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  primary key (item_key, function)
);

comment on table public.overhead_space_functions is
  'Apportions each leased suite into functional areas by square footage, and assigns each area to a cost pool. Cost/sq ft is uniform across the estate, so area is a faithful splitter.';

drop trigger if exists overhead_space_functions_touch on public.overhead_space_functions;
create trigger overhead_space_functions_touch
  before update on public.overhead_space_functions
  for each row execute function public.overhead_touch_updated_at();


-- ============================================================
-- 2. Pools — what absorbs cost, and how
-- ============================================================
create table if not exists public.overhead_pools (
  pool_key           text primary key,
  label              text not null,
  -- run_day    : a packaging line running for a day
  -- batch_day  : a cook batch occupying the kettle for a day
  -- margin     : no time driver; spread across departments by gross margin
  absorption         text not null check (absorption in ('run_day','batch_day','margin')),
  -- Divisor. Run-days or batch-days per month. NULL for margin pools.
  capacity_per_month numeric,
  notes              text,
  updated_at         timestamptz not null default now(),
  updated_by_email   text
);

comment on column public.overhead_pools.capacity_per_month is
  'The divisor. Set to ACTUAL measured throughput, not theoretical machine capacity — see the note on the cp_packaging row. Raising it lowers the rate per job and leaves more of the pool unrecovered.';

drop trigger if exists overhead_pools_touch on public.overhead_pools;
create trigger overhead_pools_touch
  before update on public.overhead_pools
  for each row execute function public.overhead_touch_updated_at();


-- ============================================================
-- 3. Facility-pool shares by department
-- ============================================================
-- The facility pool (warehouse + office, ~68% of the rent) has no time driver.
-- Purchased-bulk resale consumes warehouse and office heavily but almost no
-- production days, so a day-based rule would let the largest part of the
-- business ride free while CP and gummy carried the building.
--
-- Gross margin dollars is the driver: every department has it, it is derivable
-- from Won workflows by quote type, and it tracks burden far better than
-- revenue would (resale is a thin markup on purchased goods, so revenue would
-- make it absorb wildly more than it causes).
create table if not exists public.overhead_facility_shares (
  line_key   text primary key,
  share_pct  numeric not null check (share_pct >= 0 and share_pct <= 100),
  basis      text not null default 'gross_margin',
  notes      text,
  updated_at timestamptz not null default now(),
  updated_by_email text
);

drop trigger if exists overhead_facility_shares_touch on public.overhead_facility_shares;
create trigger overhead_facility_shares_touch
  before update on public.overhead_facility_shares
  for each row execute function public.overhead_touch_updated_at();


-- ============================================================
-- 4. Seeds
-- ============================================================
-- Floor plan as measured, Aug 2026.
--
-- Suite 400 goes to gummy IN ITS ENTIRETY — manufacturing floor plus the office,
-- bathroom, R&D lab and drying/sample-holding space. Those exist to serve gummy
-- formulation, and carving $1,153/mo into a separate R&D cost centre would add a
-- pool for no decision it would change. Revisit if R&D starts developing
-- contract-packaging products.
--
-- Suite 300 and Suite 500/600 office space is admin, bathroom and lunch room —
-- genuine shared welfare, so it lands in the facility pool.
delete from public.overhead_space_functions
 where item_key in ('suite_300','suite_400','suite_500_600');

insert into public.overhead_space_functions (item_key, function, sq_ft, pool_key, notes) values
  ('suite_300',    'packaging',     4288, 'cp_packaging',
     'Contract Packaging floor: bottles, blisters, sachets, pouches, kitting.'),
  ('suite_300',    'warehouse',     3752, 'facility', null),
  ('suite_300',    'office',        2680, 'facility',
     'Office, bathroom, lunch area.'),
  ('suite_400',    'manufacturing', 2458, 'gummy_manufacturing', null),
  ('suite_400',    'office_rnd',     614, 'gummy_manufacturing',
     'Office, bathroom, R&D lab, R&D drying and sample holding. Serves gummy formulation, so it rides with the manufacturing pool.'),
  ('suite_500_600','warehouse',     5327, 'facility', null),
  ('suite_500_600','office',        3552, 'facility',
     'Office, bathroom, lunch area.');

-- Capacity divisors, measured from Packaging Yields v2.1 (Sep 2025 - Aug 2026),
-- counting distinct date + line + sales order:
--
--     67.2 run-days per month, 3.28 parallel runs per day, max 6
--
--     Bottles   40.2 /mo of  42 machine-days  =  96%   <- the constraint
--     Blisters  15.0 /mo of  42               =  36%
--     Pouches    7.3 /mo of  21               =  35%
--     Sachets    4.7 /mo of  84               =   6%
--     ALL       67.2 /mo of 189               =  36%
--
-- 67.2 is ACTUAL throughput, not the 189 machine-days the equipment could
-- theoretically deliver. Dividing by 189 is the stricter accounting position and
-- gives lower quoted prices, but it would leave roughly $5,100/month of
-- packaging floor deliberately unrecovered as a period cost. The decision was to
-- recover the floor from the customers who use it, and to watch idle capacity on
-- a report instead of inside the margin.
--
-- Crew, not machines, is the real limit: 21.6 people on the floor per day
-- against 9 machines that would need ~50 people to run at once.
delete from public.overhead_pools where pool_key in ('cp_packaging','gummy_manufacturing','facility');

insert into public.overhead_pools (pool_key, label, absorption, capacity_per_month, notes) values
  ('cp_packaging','Contract Packaging floor','run_day', 67.2,
     'Measured run-days/month. Theoretical machine capacity is 189; using it would leave ~$5,100/mo unrecovered.'),
  ('gummy_manufacturing','Gummy manufacturing (Suite 400)','batch_day', 21,
     'One batch at a time, 21 working days. No yield log exists for manufacturing — revisit if that changes.'),
  ('facility','Warehouse, office and welfare','margin', null,
     'No time driver. Split across departments by gross margin — see overhead_facility_shares.');

-- PLACEHOLDER SHARES. These are NOT measured. They exist so the structure is
-- complete and the arithmetic closes; every one of them is a guess and the
-- report will show them as such until real margin figures replace them.
delete from public.overhead_facility_shares;
insert into public.overhead_facility_shares (line_key, share_pct, notes) values
  ('contract_packaging', 45, 'PLACEHOLDER - needs gross margin by quote type.'),
  ('gummy_manufacturing',20, 'PLACEHOLDER - needs gross margin by quote type.'),
  ('bulk_resale',        25, 'PLACEHOLDER. No calculator exists yet, so this slice is currently UNRECOVERED rather than redistributed.'),
  ('finished_product',   10, 'PLACEHOLDER - needs gross margin by quote type.');


-- ============================================================
-- 5. Department re-key — additive, nothing renamed
-- ============================================================
-- Shares are a property of a DEPARTMENT, not of one calculator. 'bottle' was
-- keyed to the bottle board; blisters, sachets, pouches and kitting would each
-- have needed their own identical copy, and five copies of one judgement drift.
--
-- The old keys are LEFT IN PLACE so this migration and the code deploy can land
-- in either order without a window where a board asks for a key that has no
-- rows and silently costs at 0%. Drop 'bottle' and 'gummy' once both are live.
insert into public.overhead_line_shares (line_key, item_key, share_pct, sort_order, notes)
select 'contract_packaging', item_key, share_pct, sort_order,
       coalesce(notes,'') || ' [re-keyed from bottle]'
  from public.overhead_line_shares where line_key = 'bottle'
on conflict (line_key, item_key) do nothing;

insert into public.overhead_line_shares (line_key, item_key, share_pct, sort_order, notes)
select 'gummy_manufacturing', item_key, share_pct, sort_order,
       coalesce(notes,'') || ' [re-keyed from gummy]'
  from public.overhead_line_shares where line_key = 'gummy'
on conflict (line_key, item_key) do nothing;


-- ============================================================
-- 6. RLS
-- ============================================================
alter table public.overhead_space_functions  enable row level security;
alter table public.overhead_pools            enable row level security;
alter table public.overhead_facility_shares  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['overhead_space_functions','overhead_pools','overhead_facility_shares'] loop
    execute format('drop policy if exists %I_select_pharmacenter on public.%I', t, t);
    execute format('drop policy if exists %I_write_admin on public.%I', t, t);
    execute format($f$create policy %I_select_pharmacenter on public.%I for select
      using (auth.email() is not null and auth.email() like '%%@pharmacenterusa.com')$f$, t, t);
    execute format($f$create policy %I_write_admin on public.%I for all
      using (exists (select 1 from public.admins where lower(email) = lower(auth.email())))
      with check (exists (select 1 from public.admins where lower(email) = lower(auth.email())))$f$, t, t);
  end loop;
end $$;


-- ============================================================
-- 7. Resolver — pool costs and the rate per job-day
-- ============================================================
create or replace function public.overhead_pool_rates(p_asof date default null)
returns table (
  pool_key           text,
  label              text,
  absorption         text,
  sq_ft              numeric,
  monthly            numeric,
  capacity_per_month numeric,
  rate_per_day       numeric
)
language sql stable as $$
  with rent as (
    -- Rent rows in force on the as-of date, with their suite's $/sq ft.
    select r.item_key, r.monthly + coalesce(r.cam,0) as cost,
           (select sum(f.sq_ft) from public.overhead_space_functions f
             where f.item_key = r.item_key) as suite_sq_ft
      from public.overhead_for_line('contract_packaging', p_asof) r
     where r.group_key = 'rent'
  ),
  apportioned as (
    select f.pool_key, sum(f.sq_ft) as sq_ft,
           sum(f.sq_ft * (rent.cost / nullif(rent.suite_sq_ft,0))) as monthly
      from public.overhead_space_functions f
      join rent on rent.item_key = f.item_key
     group by f.pool_key
  )
  select p.pool_key, p.label, p.absorption,
         a.sq_ft, round(a.monthly, 2), p.capacity_per_month,
         case when p.capacity_per_month > 0
              then round(a.monthly / p.capacity_per_month, 2) end
    from public.overhead_pools p
    left join apportioned a on a.pool_key = p.pool_key
   order by p.absorption, p.pool_key;
$$;

comment on function public.overhead_pool_rates(date) is
  'Cost of each pool on a date, and the rate a job absorbs per run-day / batch-day. Facility pool has no rate — it is spread by overhead_facility_shares.';


-- ============================================================
-- 8. Check after running
-- ============================================================
--   select * from public.overhead_pool_rates();
--
-- Expected, on the current bands:
--
--   cp_packaging          4,288 sq ft   $ 8,040.79   / 67.2  =  $119.65 per run-day
--   gummy_manufacturing   3,072 sq ft   $ 5,770.38   / 21    =  $274.78 per batch-day
--   facility             15,311 sq ft   $28,739.34   (margin, no rate)
--                                       ----------
--                                       $42,550.51   = the whole estate
--
-- Against what the calculators charge TODAY, per job-day:
--
--   contract packaging    $383 -> $120     (3.2x lower; parallel runs were ignored)
--   gummy                 $275 -> $275     (unchanged; Suite 400 runs one at a time)
