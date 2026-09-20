-- Raw materials master list for the gummy-formula COGS calculator.
--
-- Synced from Fishbowl by /api/sync/raw-materials (parts matching
-- '%-RW-%' in their part number). Fishbowl owns: fp_code, name,
-- default_unit, default_cost_per_kg, active. Quote-app overlays:
-- default_solids, category, notes — never touched by sync once set.
--
-- Run me in the Supabase SQL Editor on the shared project (the same
-- one that holds vendors / products / customers / workflows).

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.raw_materials (
  id                  uuid primary key default gen_random_uuid(),
  fp_code             text unique,                          -- e.g. "PC-RW-0010"
  name                text not null,
  default_unit        text not null default 'kg',
  default_cost_per_kg numeric,                              -- Fishbowl avg cost
  default_solids      numeric not null default 1.0
    check (default_solids > 0 and default_solids <= 1),     -- 1.0 = neat, 0.5 = 50/50 sol, 0.8 = 80% solids syrup
  category            text check (category in ('primary','secondary','final','other') or category is null),
  notes               text,
  active              boolean not null default true,
  source              text not null default 'manual'
    check (source in ('fishbowl','manual')),
  synced_at           timestamptz,
  updated_at          timestamptz default now(),
  updated_by_email    text
);

comment on column public.raw_materials.fp_code is
  'Fishbowl part number — always carries -RW- in the middle slot for raw materials.';
comment on column public.raw_materials.default_solids is
  'Fraction of the as-added weight that is actual raw material vs water/carrier. 1.0 = use as-is; 0.5 = 50/50 in-house solution; 0.25 = 25% solution; 0.8 = 80% solids syrup.';
comment on column public.raw_materials.category is
  'Typical blend phase (primary/secondary/final). Used to pre-sort in the formula picker; can always be overridden per ingredient line.';

-- Auto-bump updated_at on any change.
create or replace function public.raw_materials_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists raw_materials_touch on public.raw_materials;
create trigger raw_materials_touch
  before update on public.raw_materials
  for each row execute function public.raw_materials_touch_updated_at();

-- Search by name/code helper index.
create index if not exists raw_materials_name_lower_idx
  on public.raw_materials (lower(name));
create index if not exists raw_materials_fp_code_idx
  on public.raw_materials (fp_code);

-- ============================================================
-- 2. RLS
-- ============================================================
alter table public.raw_materials enable row level security;

-- Drop any prior policies so re-running this script is idempotent.
drop policy if exists raw_materials_select_pharmacenter on public.raw_materials;
drop policy if exists raw_materials_insert_admin on public.raw_materials;
drop policy if exists raw_materials_update_admin on public.raw_materials;

-- Any signed-in @pharmacenterusa.com user can read.
create policy raw_materials_select_pharmacenter on public.raw_materials
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- Only admins (rows in public.admins) can insert / update via the API.
-- The Fishbowl sync uses the service-role key and bypasses RLS entirely.
create policy raw_materials_insert_admin on public.raw_materials
  for insert with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );

create policy raw_materials_update_admin on public.raw_materials
  for update using (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  ) with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );

-- ============================================================
-- 3. Seed — Nuro-Brocc Bear Gummy formula (NB-26)
--
-- 13 rows. Default cost left null — fill via admin UI or Fishbowl sync.
-- default_solids encodes the typical in-house preparation:
--   * 0.5  for 50/50 solutions (citric acid),
--   * 0.25 for 25% solutions (sodium citrate),
--   * 0.8  for 80% solids syrup (NGMO corn syrup),
--   * 1.0  for everything else.
-- ============================================================
insert into public.raw_materials
  (fp_code, name, default_unit, default_solids, category, source, notes)
values
  -- Primary blend
  ('PC-RW-0010', 'H&F Pectin CS 502 (Buffered)',                'kg', 1.00, 'primary',   'fishbowl', null),
  ('PC-RW-0079', 'Citric Acid',                                  'kg', 0.50, 'primary',   'fishbowl', 'Typically prepared as a 50/50 solution in-house (50% acid / 50% water).'),
  ('PC-RW-0066', 'Sodium Citrate',                               'kg', 0.25, 'primary',   'fishbowl', 'Typically prepared as a 25% solution in-house (25% acid / 75% water).'),
  ('PC-RW-0012', 'Sugar (granular)',                             'kg', 1.00, 'primary',   'fishbowl', null),
  ('PC-RW-0108', 'NGMO Corn Syrup 43 DE',                        'kg', 0.80, 'primary',   'fishbowl', 'As purchased: 80% solids syrup.'),
  -- Secondary blend
  ('PC-RW-0104', 'Broccoli Seed Extract (0.4% Sulforaphane)',    'kg', 1.00, 'secondary', 'fishbowl', null),
  ('PC-RW-0098', 'Broccoli Sprout Extract (1.0% Glucoraphanin)', 'kg', 1.00, 'secondary', 'fishbowl', null),
  ('PC-RW-0099', 'Sinapis alba Seed / White Mustard Seed',       'kg', 1.00, 'secondary', 'fishbowl', null),
  ('PC-RW-0020', 'Monk Fruit',                                   'kg', 1.00, 'secondary', 'fishbowl', null),
  -- Final blend
  ('PC-RW-0109', 'Green Apple Hard Candy Flavor (Capella a10152)','kg', 1.00, 'final',    'fishbowl', null),
  ('PC-RW-0052', 'Bitter Masking Flavor (FFS 218Q35)',            'kg', 1.00, 'final',    'fishbowl', null),
  ('PC-RW-0102', 'Calif Natural Color — Yellow',                  'kg', 1.00, 'final',    'fishbowl', 'Part of the Yellow/Blue (20/15) 30% blend used in NB-26. Mix yellow + blue per formula.'),
  ('PC-RW-0103', 'Calif Natural Color — Blue',                    'kg', 1.00, 'final',    'fishbowl', 'Part of the Yellow/Blue (20/15) 30% blend used in NB-26. Mix yellow + blue per formula.')
on conflict (fp_code) do nothing;
