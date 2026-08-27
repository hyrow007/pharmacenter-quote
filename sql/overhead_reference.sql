-- Plant overhead reference data — one source, every calculator, date-aware.
--
-- WHY THIS TABLE EXISTS
--
-- These figures (rent, indirect payroll, utilities) were TypeScript constants
-- in src/lib/overheadCosting.ts. That had three problems:
--
--   1. Only tools compiled into the quote repo could read them. A second app,
--      a script on the office server, or a future calculator could not.
--   2. Correcting a number meant a code change and a deploy.
--   3. Worst: rents STEP ON A SCHEDULE and a constant has no date. Somebody had
--      to remember to edit code every August and every November. Nobody did —
--      which is how a Suite 400 row survived for years after the tenant had
--      moved, and how the autumn 2026 step nearly shipped un-applied.
--
-- The fix for (3) is the point of this design: rows are EFFECTIVE-DATED and the
-- whole published schedule is loaded up front. The app asks "what was the rent
-- on the quote date" and gets the right answer with nobody touching anything.
--
-- WHAT DOES *NOT* LIVE HERE
--
--   - The MATH. overheadRowMonthly / overheadRowCharged / overheadGroupCharged
--     stay in src/lib/bottleCosting.ts, which is tested. Data here, arithmetic
--     there.
--   - JOB HISTORY. A saved quote keeps its own frozen snapshot of the rows it
--     was priced with, so it still reproduces years later. This table supplies
--     DEFAULTS for new work; it is not a record of what any job was charged.
--
-- Run me in the Supabase SQL Editor on the shared project (the same one that
-- holds customers / vendors / products / raw_materials / packaging_components).


-- ============================================================
-- 1. overhead_items — the facts, banded by date
-- ============================================================
create table if not exists public.overhead_items (
  id              uuid primary key default gen_random_uuid(),

  -- Stable identity for the THING, independent of any one rate band.
  -- Shares point at this, not at a row id, so a rent step-up does not
  -- orphan the share percentages. e.g. 'suite_300', 'quality_manager'.
  item_key        text not null,

  group_key       text not null
    check (group_key in ('rent','indirect','other')),

  label           text not null,

  -- The band this row is true for. effective_to NULL = still current.
  effective_from  date not null,
  effective_to    date,

  -- Plain monthly cost. For rent rows this is BASE rent only.
  -- For labour rows leave 0 and let rate/qty/hours derive it.
  monthly         numeric not null default 0,

  -- Lease rows: CAM / additional rent. Effective total = monthly + cam.
  cam             numeric,
  -- CAM is often a landlord ESTIMATE rather than a lease term. Flagging it
  -- lets the UI show it as provisional instead of quietly authoritative.
  cam_estimated   boolean not null default false,

  -- Labour rows: burdened-rate inputs.
  --   hourly: monthly = rate x (1 + tax% + wc%) x hours x qty
  --   salary: monthly = rate x (1 + tax% + wc%) x qty   (rate already monthly)
  pay_type        text check (pay_type in ('hourly','salary') or pay_type is null),
  rate            numeric,
  qty             numeric,
  tax_pct         numeric,
  wc_pct          numeric,
  hours           numeric,

  -- Other expenses: QuickBooks account, carried for audit reference only.
  qb_account      text,

  -- Provenance. The whole reason the old constants needed a code comment.
  source_doc      text,
  verified_on     date,
  notes           text,

  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by_email text,

  constraint overhead_items_band_sane
    check (effective_to is null or effective_to >= effective_from),
  constraint overhead_items_key_band_unique
    unique (item_key, effective_from)
);

comment on table public.overhead_items is
  'Plant overhead facts (rent, indirect payroll, other expenses), banded by effective date. Shared by every costing calculator. Math lives in code; job snapshots live on the job.';
comment on column public.overhead_items.item_key is
  'Stable id for the underlying thing across rate changes. Share percentages reference this, so a rent step-up never orphans them.';
comment on column public.overhead_items.effective_to is
  'NULL means open-ended / still current. Exactly one band per item_key should be open at a time.';
comment on column public.overhead_items.monthly is
  'BASE monthly cost. Rent rows: base rent, excluding CAM. Labour rows: leave 0, the rate/qty/hours columns derive it.';
comment on column public.overhead_items.cam_estimated is
  'True when CAM is a landlord estimate or our own extrapolation rather than a stated lease amount. Show it as provisional.';

create index if not exists overhead_items_group_idx
  on public.overhead_items (group_key) where active;
create index if not exists overhead_items_key_idx
  on public.overhead_items (item_key);
create index if not exists overhead_items_band_idx
  on public.overhead_items (effective_from, effective_to);

-- Overlapping bands for one item_key are the exact bug this table is meant to
-- prevent — two rents true on the same day. Enforce it in the database rather
-- than trusting whoever types the next amendment in.
do $$
begin
  create extension if not exists btree_gist;
  alter table public.overhead_items
    add constraint overhead_items_no_overlap
    exclude using gist (
      item_key with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    );
exception
  when duplicate_object then null;   -- already added, fine
  when others then
    raise notice 'Could not add overlap exclusion (%). Bands are unguarded — check manually.', sqlerrm;
end $$;


-- ============================================================
-- 2. overhead_line_shares — the judgements, per production line
-- ============================================================
--
-- The amounts above are facts about the building and the payroll. How much of
-- each one a given production line should BEAR is a judgement, and it differs
-- by line. PharmaCenter's floor:
--
--     Suite 300      offices + PACKAGING
--     Suite 400      gummy MANUFACTURING
--     Suite 500/600  warehouse, shared
--
-- so a gummy batch and a bottling job do not charge the same rooms. A single
-- shared list of shares could not express that, which is what caused two
-- calculators to fight over one array.
--
-- line_key is deliberately UNCONSTRAINED text: adding a blister or sachet
-- calculator should be an INSERT, not a migration.
create table if not exists public.overhead_line_shares (
  line_key    text not null,
  item_key    text not null,
  share_pct   numeric not null default 0
                check (share_pct >= 0 and share_pct <= 100),
  sort_order  int not null default 0,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by_email text,
  primary key (line_key, item_key)
);

comment on table public.overhead_line_shares is
  'Percent of each overhead item charged to a given production line. line_key is open text so a new calculator is a data change, not a migration.';
comment on column public.overhead_line_shares.share_pct is
  '0 is a deliberate claim ("this line does not use that space"), NOT the same as a missing row ("nobody has considered it"). Keep zero rows; do not delete them.';


-- ============================================================
-- 3. Touch triggers
-- ============================================================
create or replace function public.overhead_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists overhead_items_touch on public.overhead_items;
create trigger overhead_items_touch
  before update on public.overhead_items
  for each row execute function public.overhead_touch_updated_at();

drop trigger if exists overhead_line_shares_touch on public.overhead_line_shares;
create trigger overhead_line_shares_touch
  before update on public.overhead_line_shares
  for each row execute function public.overhead_touch_updated_at();


-- ============================================================
-- 4. Settings — so nothing needs remembering
-- ============================================================
create table if not exists public.overhead_settings (
  key         text primary key,
  value_num   numeric,
  value_text  text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by_email text
);

drop trigger if exists overhead_settings_touch on public.overhead_settings;
create trigger overhead_settings_touch
  before update on public.overhead_settings
  for each row execute function public.overhead_touch_updated_at();

insert into public.overhead_settings (key, value_num, notes) values
  ('quote_lead_days', 60,
   'Days between quoting a job and actually running it. The resolver costs at the rent payable ON THE PRODUCTION DATE rather than the day the quote was typed — which is exactly what the operator was doing by hand when they picked the autumn 2026 rates back in August. Adjust this number, never any code.')
on conflict (key) do nothing;

alter table public.overhead_settings enable row level security;
drop policy if exists overhead_settings_select_pharmacenter on public.overhead_settings;
drop policy if exists overhead_settings_write_admin on public.overhead_settings;
create policy overhead_settings_select_pharmacenter on public.overhead_settings
  for select using (
    auth.email() is not null and auth.email() like '%@pharmacenterusa.com'
  );
create policy overhead_settings_write_admin on public.overhead_settings
  for all using (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  ) with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );


-- ============================================================
-- 5. Resolver — "what is true when this job actually runs"
-- ============================================================
-- Call it with no date and it works the as-of out for itself:
--     current_date + overhead_settings.quote_lead_days
-- so the rates step over on their own. Nothing to trigger, nothing to diarise.
--
-- Two behaviours worth knowing about:
--
--   * Shares are LEFT joined, so an item with no share row for this line still
--     comes back at 0 and stays visible. "Absent from the screen" and "charged
--     at nothing" are different claims and should look different.
--
--   * NO BAND COVERS THE DATE? It returns the nearest band anyway and marks it
--     status='expired'. Suites 400 and 500/600 both have lease terms ending
--     31 Jan 2028. Filtering strictly would make those two rows silently VANISH
--     overnight, dropping about $18k/month of overhead out of every quote with
--     no error and nothing on screen to notice. A flagged stale row is a
--     question; a missing row is a wrong number nobody sees. This is the whole
--     "don't make me remember" requirement — the system has to notice for you.
create or replace function public.overhead_for_line(
  p_line_key text,
  p_asof     date default null
)
returns table (
  item_key       text,
  group_key      text,
  label          text,
  monthly        numeric,
  cam            numeric,
  cam_estimated  boolean,
  pay_type       text,
  rate           numeric,
  qty            numeric,
  tax_pct        numeric,
  wc_pct         numeric,
  hours          numeric,
  qb_account     text,
  share_pct      numeric,
  source_doc     text,
  verified_on    date,
  effective_from date,
  effective_to   date,
  status         text,
  days_left      int,
  asof_used      date,
  sort_order     int
)
language sql stable as $$
  with cfg as (
    select coalesce(
             p_asof,
             current_date + coalesce(
               (select value_num from public.overhead_settings
                 where key = 'quote_lead_days'),
               0
             )::int
           ) as asof
  ),
  picked as (
    select distinct on (i.item_key) i.*, cfg.asof,
           case
             when i.effective_from <= cfg.asof
              and (i.effective_to is null or i.effective_to >= cfg.asof)
               then 'current'
             when i.effective_to is not null and i.effective_to < cfg.asof
               then 'expired'
             else 'not_yet'
           end as status
      from public.overhead_items i, cfg
     where i.active
     order by i.item_key,
              -- a band that actually covers the date always wins...
              (i.effective_from <= cfg.asof
               and (i.effective_to is null or i.effective_to >= cfg.asof)) desc,
              -- ...otherwise fall back to the nearest one so the row still shows
              abs(cfg.asof - i.effective_from) asc
  )
  select p.item_key, p.group_key, p.label, p.monthly, p.cam, p.cam_estimated,
         p.pay_type, p.rate, p.qty, p.tax_pct, p.wc_pct, p.hours, p.qb_account,
         coalesce(s.share_pct, 0) as share_pct,
         p.source_doc, p.verified_on, p.effective_from, p.effective_to,
         p.status,
         case when p.effective_to is null then null
              else (p.effective_to - p.asof)::int end as days_left,
         p.asof as asof_used,
         coalesce(s.sort_order, 999) as sort_order
    from picked p
    left join public.overhead_line_shares s
           on s.item_key = p.item_key
          and s.line_key = p_line_key
   order by
     case p.group_key when 'rent' then 1 when 'indirect' then 2 else 3 end,
     coalesce(s.sort_order, 999),
     p.label;
$$;

comment on function public.overhead_for_line(text, date) is
  'Overhead rows for one production line, resolved to the date the job will RUN (current_date + quote_lead_days) unless an explicit date is passed. Lapsed bands come back flagged status=expired instead of disappearing.';

-- Anything lapsed, ending within 90 days, or still resting on an estimate.
-- Point a dashboard tile or a scheduled task at this and the lease renewals
-- chase you rather than the other way round.
-- security_invoker: without it a view runs with its OWNER's rights and quietly
-- bypasses the row-level security above, so anyone who can reach the view can
-- read the plant's cost base. Run it as the caller instead.
create or replace view public.overhead_attention
  with (security_invoker = true) as
  select item_key, label, group_key, status, days_left, effective_to,
         cam_estimated, source_doc, verified_on, asof_used
    from public.overhead_for_line('gummy')
   where status <> 'current'
      or (days_left is not null and days_left <= 90)
      or cam_estimated;

comment on view public.overhead_attention is
  'Overhead rows wanting a human: lapsed bands, bands ending within 90 days, and CAM figures that are still estimates. Line-agnostic — amounts and dates are the same whichever line you ask for.';


-- ============================================================
-- 6. RLS — same shape as packaging_components / raw_materials
-- ============================================================
alter table public.overhead_items       enable row level security;
alter table public.overhead_line_shares enable row level security;

drop policy if exists overhead_items_select_pharmacenter on public.overhead_items;
drop policy if exists overhead_items_write_admin        on public.overhead_items;
drop policy if exists overhead_shares_select_pharmacenter on public.overhead_line_shares;
drop policy if exists overhead_shares_write_admin        on public.overhead_line_shares;

create policy overhead_items_select_pharmacenter on public.overhead_items
  for select using (
    auth.email() is not null and auth.email() like '%@pharmacenterusa.com'
  );

create policy overhead_items_write_admin on public.overhead_items
  for all using (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  ) with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );

create policy overhead_shares_select_pharmacenter on public.overhead_line_shares
  for select using (
    auth.email() is not null and auth.email() like '%@pharmacenterusa.com'
  );

create policy overhead_shares_write_admin on public.overhead_line_shares
  for all using (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  ) with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );


-- ============================================================
-- 7. Seed — the current constants, plus every published future band
-- ============================================================
-- Re-runnable: deletes the seeded keys and reinserts. Safe until someone edits
-- a row in the admin UI, at which point DO NOT re-run this section blindly.

delete from public.overhead_items
 where item_key in (
   'suite_300','suite_400','suite_500_600',
   'production_manager','plant_mechanic','quality_manager','quality_tech',
   'quality_tech_ii','warehouse_staff','purchasing_logistics',
   'electricity','warehouse_supplies','licenses_permits','insurance',
   'repairs_maintenance','cleaning','other_utilities'
 );

-- ---------- Rent: Suite 300, offices + packaging ----------
-- Sixth Amendment to Lease (July 2025). 15851 SW 41st Street, Davie FL,
-- ~10,720 rentable sq ft. Extended term 1 Aug 2025 - 30 Nov 2030.
-- Rate is annual $/sq ft: 10,720 x 17.16 / 12 = 15,329.60 reproduces it exactly.
-- CAM: $4,772.39/mo, from the 2025 CAM Reconciliation (Pointe West Commerce
-- Center). The amendment itself states no amount — only "Tenant's pro-rata share
-- of Expenses as Additional Rent" — so the reconciliation is the source:
--
--     2025 recoverable expenses   $327,799.23
--     pro-rata share  10,720 / 61,360 sq ft  =  17.47%
--     annual share                 $57,268.71   /12 = $4,772.39
--
-- The statement's 10,720 sq ft matches the lease exactly, which is a good
-- cross-check on both documents.
--
-- Landlord BILLED $56,902.80 for 2025 ($4,741.90/mo) and trued up $365.91. We
-- carry the RECONCILED figure, not the billed one: the billed amount is the
-- landlord's estimate, the reconciliation is what the space actually cost, and
-- costing off the estimate builds in a small known error.
--
-- Two oddities on the form, neither material: it labels the expense pool "2023
-- Operating Expenses" in the header while the table beneath says 2025 and the
-- totals agree, and it claims 366 days occupied in a 365-day year.
--
-- THIS IS RECONCILED ANNUALLY. When the 2026 statement lands, add a new band —
-- do not edit this row, or the history stops reproducing.
insert into public.overhead_items
  (item_key, group_key, label, effective_from, effective_to, monthly, cam, cam_estimated, source_doc, verified_on, notes)
values
  ('suite_300','rent','Suite 300','2025-08-01','2026-07-31',14740.00,4772.39,false,'Base: Sixth Amendment (Jul 2025). CAM: 2025 CAM Reconciliation, Pointe West Commerce Center','2026-08-27','$16.50/sq ft. First four months of the extended term were abated (free rent value $58,960).'),
  ('suite_300','rent','Suite 300','2026-08-01','2027-07-31',15329.60,4772.39,false,'Base: Sixth Amendment (Jul 2025). CAM: 2025 CAM Reconciliation, Pointe West Commerce Center','2026-08-27','$17.16/sq ft.'),
  ('suite_300','rent','Suite 300','2027-08-01','2028-07-31',15942.78,4772.39,false,'Base: Sixth Amendment (Jul 2025). CAM: 2025 CAM Reconciliation, Pointe West Commerce Center','2026-08-27','$17.85/sq ft.'),
  ('suite_300','rent','Suite 300','2028-08-01','2029-07-31',16580.53,4772.39,false,'Base: Sixth Amendment (Jul 2025). CAM: 2025 CAM Reconciliation, Pointe West Commerce Center','2026-08-27','$18.56/sq ft.'),
  ('suite_300','rent','Suite 300','2029-08-01','2030-07-31',17243.75,4772.39,false,'Base: Sixth Amendment (Jul 2025). CAM: 2025 CAM Reconciliation, Pointe West Commerce Center','2026-08-27','$19.30/sq ft.'),
  ('suite_300','rent','Suite 300','2030-08-01','2030-11-30',17933.49,4772.39,false,'Base: Sixth Amendment (Jul 2025). CAM: 2025 CAM Reconciliation, Pointe West Commerce Center','2026-08-27','$20.07/sq ft. Term ends 30 Nov 2030.');

-- ---------- Rent: Suite 400, gummy manufacturing ----------
-- Fifth Amendment to Lease (Oct 2022). 15951 SW 41st Street, ~3,072 sq ft.
-- Term ends 31 Jan 2028.
--
-- CAM: SEE THE SUITE 500/600 NOTE BELOW BEFORE CHANGING THIS. The 2025
-- reconciliation for building 15951 is issued as ONE statement covering 11,951
-- sq ft, which is Suite 400 (3,072) plus Suite 500/600 (8,879) together. The
-- $1,588.30 here is that single CAM split by floor area, NOT a separate bill.
-- Raising it without lowering the other row double-charges the building.
insert into public.overhead_items
  (item_key, group_key, label, effective_from, effective_to, monthly, cam, cam_estimated, source_doc, verified_on, notes)
values
  ('suite_400','rent','Suite 400','2025-11-21','2026-10-31',4182.08,1588.30,true,'Base: Fifth Amendment (Oct 2022). CAM: 2025 CAM Reconciliation for Bldg 15951, split by floor area','2026-08-27','CAM from the landlord''s 2026 estimate letter / rent ledger.'),
  ('suite_400','rent','Suite 400','2026-11-01','2027-10-31',4307.55,1588.30,true,'Base: Fifth Amendment (Oct 2022). CAM: 2025 CAM Reconciliation for Bldg 15951, split by floor area','2026-08-27','CAM carried forward from the 2026 estimate; re-estimated annually.'),
  ('suite_400','rent','Suite 400','2027-11-01','2028-01-31',4436.77,1588.30,true,'Base: Fifth Amendment (Oct 2022). CAM: 2025 CAM Reconciliation for Bldg 15951, split by floor area','2026-08-27','Final band; term ends 31 Jan 2028.');

-- ---------- Rent: Suite 500/600, shared warehouse ----------
-- Fourth Amendment to Lease (Dec 2021). 15951 SW 41st Street, ~8,879 sq ft.
-- Term ends 31 Jan 2028. Rent is banded by LEASE MONTH from the 18 Oct 2022
-- commencement, so the calendar dates below are the month bands mapped across
-- and are APPROXIMATE at the boundaries — confirm against the rent ledger
-- before relying on a quote dated within a few days of a step.
--
-- CAM — AND A DOUBLE-COUNT THIS UNCOVERED.
--
-- The 2025 CAM Reconciliation for building 15951 reads:
--
--     tenant "Pharmacenter, Suite: 500/600, Bldg: 15951"
--     11,951 sq ft of 50,651        pro-rata share 23.59%
--     2025 recoverable expenses     $314,253.73
--     annual share                   $74,147.53   /12 = $6,178.96
--
-- But 11,951 is not Suite 500/600 on its own. Suite 500/600 is ~8,879 sq ft and
-- Suite 400 is ~3,072, and 8,879 + 3,072 = 11,951 exactly. The landlord bills
-- ONE CAM for both spaces under the 500/600 lease ID.
--
-- So the previous model was double-charging: $5,132.38 for 500/600 PLUS
-- $1,775.73 for Suite 400 = $6,908.11/mo against a real bill of $6,178.96.
--
-- The single CAM is therefore split back out by floor area, so that each suite
-- keeps its own share percentage (Suite 400 is 100% gummy / 0% bottle; 500/600
-- is shared) instead of collapsing them into one row:
--
--     Suite 400      3,072 / 11,951  =  25.70%  ->  $1,588.30
--     Suite 500/600  8,879 / 11,951  =  74.30%  ->  $4,590.66
--                                                   ---------
--                                                   $6,178.96
--
-- Both rows stay flagged cam_estimated because the SPLIT is our arithmetic even
-- though the total is documented. The 3,072 / 8,879 areas come from the Fourth
-- and Fifth Amendments; if either is wrong the split moves. Worth one look at
-- the amendments to confirm, and worth asking the property manager why the two
-- suites share a CAM line.
--
-- Landlord billed $63,204.60 for 2025 ($5,267.05/mo) and trued up $10,942.93 —
-- a large under-billing, which is exactly why we cost off the reconciled figure
-- rather than the monthly estimate.
--
-- The earlier "why is CAM 42% of base here but 23% on Suite 300" question is
-- now answered: different buildings, different expense pools. 15951 recovers
-- $314,253.73 over 50,651 sq ft; 15851 recovers $327,799.23 over 61,360.
--
-- RECONCILED ANNUALLY — add a new band when the 2026 statement arrives.
insert into public.overhead_items
  (item_key, group_key, label, effective_from, effective_to, monthly, cam, cam_estimated, source_doc, verified_on, notes)
values
  ('suite_500_600','rent','Suite 500/600','2025-11-01','2026-10-31',12087.48,4590.66,true,'Base: Fourth Amendment (Dec 2021). CAM: 2025 CAM Reconciliation for Bldg 15951, split by floor area','2026-08-27','Lease months 37-48. Calendar mapping approximate.'),
  ('suite_500_600','rent','Suite 500/600','2026-11-01','2027-10-31',12450.10,4590.66,true,'Base: Fourth Amendment (Dec 2021). CAM: 2025 CAM Reconciliation for Bldg 15951, split by floor area','2026-08-27','Lease months 49-60. Calendar mapping approximate.'),
  ('suite_500_600','rent','Suite 500/600','2027-11-01','2028-01-31',12823.60,4590.66,true,'Base: Fourth Amendment (Dec 2021). CAM: 2025 CAM Reconciliation for Bldg 15951, split by floor area','2026-08-27','Lease months 61-63. Term ends 31 Jan 2028.');

-- ---------- Indirect labour ----------
-- ADP roster, burdened at 8.5% payroll tax + 4% workers' comp, 173.33 h/mo.
-- Open-ended band: payroll has no published schedule, so these stay current
-- until someone changes them.
insert into public.overhead_items
  (item_key, group_key, label, effective_from, monthly, pay_type, rate, qty, tax_pct, wc_pct, hours, source_doc, verified_on, notes)
values
  ('production_manager','indirect','Production Manager','2026-01-01',0,'salary',4525.41,1,8.5,4,173.33,'ADP roster','2026-08-27',null),
  ('plant_mechanic','indirect','Plant Mechanic','2026-01-01',0,'hourly',26.00,1,8.5,4,173.33,'ADP roster','2026-08-27',null),
  ('quality_manager','indirect','Quality Manager','2026-01-01',0,'salary',5250.01,1,8.5,4,173.33,'ADP roster','2026-08-27',null),
  ('quality_tech','indirect','Quality Tech','2026-01-01',0,'hourly',17.00,1,8.5,4,173.33,'ADP roster','2026-08-27',null),
  ('quality_tech_ii','indirect','Quality Tech II','2026-01-01',0,'hourly',15.00,1,8.5,4,173.33,'ADP roster','2026-08-27',null),
  ('warehouse_staff','indirect','Warehouse Staff','2026-01-01',0,'hourly',15.00,3,8.5,4,173.33,'ADP roster','2026-08-27',null),
  ('purchasing_logistics','indirect','Purchasing Logistics','2026-01-01',0,'salary',1741.31,1,8.5,4,173.33,'ADP roster','2026-08-27','Part-time salaried: $803.68 biweekly x 26 / 12 = $1,741.31/mo.');

-- ---------- Other expenses ----------
-- Jan-Jun 2026 P&L averages.
insert into public.overhead_items
  (item_key, group_key, label, effective_from, monthly, qb_account, source_doc, verified_on)
values
  ('electricity','other','Electricity','2026-01-01',4497,'5135.30','P&L Jan-Jun 2026 average','2026-08-27'),
  ('warehouse_supplies','other','Warehouse Supplies & Tools','2026-01-01',2525,'5195.19','P&L Jan-Jun 2026 average','2026-08-27'),
  ('licenses_permits','other','Licenses & Permits','2026-01-01',2428,'5145.70','P&L Jan-Jun 2026 average','2026-08-27'),
  ('insurance','other','Insurance (liability + property)','2026-01-01',3281,'5130','P&L Jan-Jun 2026 average','2026-08-27'),
  ('repairs_maintenance','other','Repairs & Maintenance','2026-01-01',1278,'5145','P&L Jan-Jun 2026 average','2026-08-27'),
  ('cleaning','other','Cleaning','2026-01-01',675,'5135.05','P&L Jan-Jun 2026 average','2026-08-27'),
  ('other_utilities','other','Other Utilities & Services','2026-01-01',291,'5135','P&L Jan-Jun 2026 average','2026-08-27');


-- ---------- Shares: gummy line ----------
-- Mirrors OVERHEAD_RENT_DEFAULTS_GUMMY exactly. Suite 300 at 0 is deliberate
-- and stays as a visible row.
insert into public.overhead_line_shares (line_key, item_key, share_pct, sort_order, notes) values
  ('gummy','suite_400',      100, 10, 'Gummy manufacturing happens here.'),
  ('gummy','suite_300',        0, 20, 'Offices and packaging: no part of a gummy run happens here.'),
  ('gummy','suite_500_600',   50, 30, null),
  ('gummy','production_manager',   25, 10, null),
  ('gummy','plant_mechanic',       25, 20, null),
  ('gummy','quality_manager',      25, 30, null),
  ('gummy','quality_tech',         25, 40, null),
  ('gummy','quality_tech_ii',      25, 50, null),
  ('gummy','warehouse_staff',      25, 60, null),
  ('gummy','purchasing_logistics', 25, 70, null),
  ('gummy','electricity',          30, 10, null),
  ('gummy','warehouse_supplies',   40, 20, null),
  ('gummy','licenses_permits',     40, 30, null),
  ('gummy','insurance',            40, 40, null),
  ('gummy','repairs_maintenance',  40, 50, null),
  ('gummy','cleaning',             40, 60, null),
  ('gummy','other_utilities',      40, 70, null)
on conflict (line_key, item_key) do update
  set share_pct = excluded.share_pct,
      sort_order = excluded.sort_order,
      notes = excluded.notes;

-- ---------- Shares: contract-packaging bottle line ----------
-- Rent shares are set for bottling. The indirect and other percentages are
-- INHERITED from the gummy line unreviewed — seeded identical so switching to
-- this table changes nothing silently. They still want a look.
insert into public.overhead_line_shares (line_key, item_key, share_pct, sort_order, notes) values
  ('bottle','suite_300',     100, 10, 'Packaging happens here. NOTE: the suite is offices AND packaging, so 100% charges a bottling job for office floor too — pending a call on the split.'),
  ('bottle','suite_400',       0, 20, 'Gummy manufacturing: a bottling job does not use it.'),
  ('bottle','suite_500_600',  50, 30, null),
  ('bottle','production_manager',   25, 10, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','plant_mechanic',       25, 20, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','quality_manager',      25, 30, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','quality_tech',         25, 40, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','quality_tech_ii',      25, 50, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','warehouse_staff',      25, 60, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','purchasing_logistics', 25, 70, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','electricity',          30, 10, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','warehouse_supplies',   40, 20, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','licenses_permits',     40, 30, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','insurance',            40, 40, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','repairs_maintenance',  40, 50, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','cleaning',             40, 60, 'Inherited from the gummy line — unreviewed for bottling.'),
  ('bottle','other_utilities',      40, 70, 'Inherited from the gummy line — unreviewed for bottling.')
on conflict (line_key, item_key) do update
  set share_pct = excluded.share_pct,
      sort_order = excluded.sort_order,
      notes = excluded.notes;


-- ============================================================
-- 8. Sanity check
-- ============================================================
--
--   select line, round(sum((monthly + coalesce(cam,0)) * share_pct / 100), 2)
--     from (
--       select 'gummy'  as line, * from public.overhead_for_line('gummy')
--       union all
--       select 'bottle' as line, * from public.overhead_for_line('bottle')
--     ) x
--    where group_key = 'rent'
--    group by line;
--
-- Run today (27 Aug 2026) with the default 60-day lead, the as-of lands on
-- 26 Oct 2026 and you get:
--
--   gummy  14,109.45      bottle  28,441.06
--
-- Run it again after 1 Nov 2026 — or with quote_lead_days at 66 or more — and
-- the autumn bands take over on their own:
--
--   gummy  14,416.23      bottle  28,622.37
--
-- These differ from the hardcoded constants (14,874.52 / 27,710.84) for two
-- reasons, both improvements:
--
--   * Suite 300's CAM went from a $3,590 guess to the reconciled $4,772.39,
--     which raises the BOTTLE line by about $1,180/mo.
--   * The Suite 400 + 500/600 CAM double-count came out: $6,908.11 of charges
--     against a $6,178.96 bill. That lowers the GUMMY line, which was carrying
--     most of it.
--
-- WHY THE LEAD DAYS MATTER, and why 60 is a guess I want checked.
--
-- The hardcoded constants this replaces carry the SECOND pair. Suite 400 at
-- 4,307.55 and Suite 500/600 at 12,450.10 are the bands beginning 1 Nov 2026;
-- today's leases actually say 4,182.08 and 12,087.48. That was not a mistake —
-- the operator picked the autumn rates on purpose, because a job quoted in
-- August gets produced after the step-up. Costing at the rent payable when the
-- work runs is the correct instinct, and quote_lead_days is that instinct
-- written down where it can be seen and adjusted.
--
-- But 60 days is MY number, not a measured one. At 60 the crossover happens on
-- 2 Sept 2026; the real lead time between quoting and running a job is
-- something the operator knows and I do not. Too short and quotes briefly use
-- the expiring rate (~$300/mo light on gummy, ~$180/mo on bottles); too long
-- and they charge a rent that is not yet payable. One row to change:
--
--   update public.overhead_settings set value_num = <days> where key = 'quote_lead_days';
