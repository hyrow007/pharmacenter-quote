-- Indirect labour by POOL — the lease cure, applied to people.
--
-- Run after overhead_reference.sql, overhead_pools.sql and
-- overhead_lease_rate.sql.
--
-- The Indirect Labor card carried the same two faults the lease did: a
-- hand-typed 25% share nobody could defend, and a ÷21 calendar-day divisor
-- that ignored ~3 jobs running in parallel. Same question fixes both:
-- WHO DOES THIS PERSON'S WORK SERVE?
--
--   production support   manager, mechanic, quality — their day is consumed
--                        by production days wherever they happen, so their
--                        cost divides by ALL production days in the plant at
--                        EQUAL WEIGHT (decision 2026-08-30): 67.2 packaging
--                        run-days + 21 gummy batch-days = 88.2. No time
--                        study exists to justify weighting one floor's day
--                        heavier, and an unmeasured weight is the old Share%
--                        guess in a new outfit. If a floor is ever shown to
--                        hog someone (the mechanic and the kettle is the
--                        candidate), measure it and put the weight HERE with
--                        its reasoning.
--
--   facility             warehouse crew, purchasing — no time driver, like
--                        warehouse rent, so the line's gross-margin share
--                        over its own run-days.
--
-- Sanity check that recommended this model: Q0016 at 1.5 days absorbs
-- ~$574.50 under the pools vs ~$590 under the old 25% shares — the old guess
-- was accidentally right in total; the pools give the number reasons.

-- ============================================================
-- 1. Production-support pool
-- ============================================================
-- capacity_per_month is left NULL on purpose: the resolver derives 88.2 from
-- cp_packaging + gummy_manufacturing at query time, so a re-measured floor
-- capacity updates this pool automatically instead of drifting.
insert into public.overhead_pools (pool_key, label, absorption, capacity_per_month, notes)
values ('production_support', 'Production support (people)', 'run_day', null,
  'Manager, mechanic and quality. Divisor derived at query time as the sum of cp_packaging and gummy_manufacturing capacities (currently 67.2 + 21 = 88.2), at equal weight per the 2026-08-30 decision.')
on conflict (pool_key) do update set label = excluded.label, notes = excluded.notes;

-- ============================================================
-- 2. Role -> pool
-- ============================================================
-- A person's pool is a property of the ROLE, not of a date band, so it lives
-- in its own small table keyed by item_key rather than as a column on the
-- banded overhead_items rows.
create table if not exists public.overhead_item_pools (
  item_key text primary key,
  pool_key text not null,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by_email text
);

comment on table public.overhead_item_pools is
'Which cost pool an indirect-labour role belongs to. Replaces the hand-typed share% on the calculators: production_support divides by all plant production days, facility takes the line''s gross-margin share.';

drop trigger if exists overhead_item_pools_touch on public.overhead_item_pools;
create trigger overhead_item_pools_touch
  before update on public.overhead_item_pools
  for each row execute function public.overhead_touch_updated_at();

alter table public.overhead_item_pools enable row level security;
drop policy if exists overhead_item_pools_select_pharmacenter on public.overhead_item_pools;
drop policy if exists overhead_item_pools_write_admin on public.overhead_item_pools;
create policy overhead_item_pools_select_pharmacenter on public.overhead_item_pools for select
  using (auth.email() is not null and auth.email() like '%@pharmacenterusa.com');
create policy overhead_item_pools_write_admin on public.overhead_item_pools for all
  using (exists (select 1 from public.admins where lower(email) = lower(auth.email())))
  with check (exists (select 1 from public.admins where lower(email) = lower(auth.email())));

delete from public.overhead_item_pools;
insert into public.overhead_item_pools (item_key, pool_key, notes) values
  ('production_manager',   'production_support', 'Serves every job running, both floors.'),
  ('plant_mechanic',       'production_support', 'Maintains the machines, both floors. Candidate for a measured weight if the kettle dominates his time.'),
  ('quality_manager',      'production_support', 'Releases every job. Decision 2026-08-30: quality rides on production days; revisit if lot-count data is ever wired.'),
  ('quality_tech',         'production_support', 'Releases every job.'),
  ('quality_tech_ii',      'production_support', 'Releases every job.'),
  ('warehouse_staff',      'facility', 'Moves goods for whichever line earns them — same logic as warehouse rent.'),
  ('purchasing_logistics', 'facility', 'Buys for whichever line earns — same logic as office rent.');

-- ============================================================
-- 3. Resolver — one row per role, one division per row
-- ============================================================
create or replace function public.overhead_indirect_breakdown(
  p_line_key text,
  p_asof     date default null
)
returns table (
  item_key          text,
  role_label        text,
  pool_key          text,
  pool_label        text,
  burdened_monthly  numeric,
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
  -- All production days in the plant, derived rather than stored so a
  -- re-measured capacity flows through automatically.
  plant_days as (
    select sum(capacity_per_month) as days
    from public.overhead_pools
    where pool_key in ('cp_packaging','gummy_manufacturing')
  ),
  rows_ as (
    -- Burdened monthly, mirroring lib/bottleCosting.ts overheadRowMonthly():
    -- salary  rate x (1 + tax% + wc%) x qty
    -- hourly  rate x (1 + tax% + wc%) x hours x qty
    select r.item_key, r.label, r.sort_order,
           case when r.pay_type = 'salary'
             then coalesce(r.rate,0)
                  * (1 + coalesce(r.tax_pct,8.5)/100 + coalesce(r.wc_pct,4)/100)
                  * coalesce(r.qty,1)
             else coalesce(r.rate,0)
                  * (1 + coalesce(r.tax_pct,8.5)/100 + coalesce(r.wc_pct,4)/100)
                  * coalesce(r.hours,173.33) * coalesce(r.qty,1)
           end as burdened
    from public.overhead_for_line(p_line_key, p_asof) r
    where r.group_key = 'indirect'
  )
  select rw.item_key, rw.label, ip.pool_key, pl.label,
         round(rw.burdened, 2) as burdened_monthly,
         case
           when ip.pool_key = 'production_support' then round(rw.burdened, 2)
           when ip.pool_key = 'facility'
             then round(rw.burdened * (select share_pct from s) / 100, 2)
           else 0
         end as charged_monthly,
         case
           when ip.pool_key = 'production_support' then (select days from plant_days)
           when ip.pool_key = 'facility' then (select run_days_per_month from s)
         end as divisor_days,
         case
           when ip.pool_key = 'production_support'
                and (select days from plant_days) > 0
             then round(rw.burdened / (select days from plant_days), 2)
           when ip.pool_key = 'facility'
                and (select run_days_per_month from s) > 0
             then round(rw.burdened * (select share_pct from s) / 100
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

comment on function public.overhead_indirect_breakdown(text, date) is
'One row per indirect-labour role: burdened monthly, the line''s slice, and a per-run-day rate. rate_per_day sums to the indirect rate a job absorbs per occupancy day. A role missing from overhead_item_pools is EXCLUDED by the join — deliberately loud, since a silently-uncharged person is the invisible-zero failure this whole design exists to prevent.';

-- ============================================================
-- 4. Check after running
-- ============================================================
--   select * from public.overhead_indirect_breakdown('contract_packaging');
--
-- Expected on the current bands (12,000-bottle Q0016 at 1.5 days -> ~$574.50):
--
--   production_manager    5,091.09  /88.2  =  57.72
--   plant_mechanic        5,069.90  /88.2  =  57.48
--   quality_manager       5,906.26  /88.2  =  66.96
--   quality_tech          3,314.94  /88.2  =  37.58
--   quality_tech_ii       2,924.94  /88.2  =  33.16
--   warehouse_staff       8,774.83 x63.12% /52.08 = 106.35
--   purchasing_logistics  1,958.97 x63.12% /52.08 =  23.74
--                                             ------
--                                             382.99 per run-day
