-- Packaging components master list for the Contract-Packaging (Bottles)
-- costing calculator.
--
-- Synced from Fishbowl by /api/sync/packaging-components (parts whose
-- number carries one of three infixes):
--
--     -PK-   bottles, caps/closures, liners, master boxes  (packaging)
--     -LL-   labels
--     -UC-   unit cartons / IFCs (inserts)
--
-- ...and one of two OWNER prefixes:
--
--     PC-…   PharmaCenter-purchased  → real cost, from Fishbowl
--     CA-…   customer asset          → ALWAYS $0 (free issue)
--
-- Fishbowl owns: fp_code, name, default_unit, the two cost columns, active.
-- Quote-app overlays: category, notes — never touched by sync once set.
--
-- Deliberately NOT folded into public.raw_materials: those cost columns are
-- named *_per_kg and raw materials genuinely are priced per kg. A bottle is
-- priced per EACH. Storing an each-price in a column named per_kg reads fine
-- today and produces a wrong quote later.
--
-- Run me in the Supabase SQL Editor on the shared project (the same one that
-- holds vendors / products / customers / workflows / raw_materials).

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.packaging_components (
  id                        uuid primary key default gen_random_uuid(),
  fp_code                   text unique,          -- e.g. "PC-PK-0031", "CA-LL-0007"
  name                      text not null,
  default_unit              text not null default 'ea',

  -- Who buys it. Parsed from the fp_code prefix by the sync.
  owner                     text not null default 'pharmacenter'
    check (owner in ('pharmacenter','customer')),

  -- Which Fishbowl infix it came from. Parsed by the sync; drives the
  -- default category when the app hasn't curated one yet.
  kind                      text
    check (kind in ('pk','ll','uc') or kind is null),

  -- Fishbowl cost sources, mirroring raw_materials.{inventory,last_order}:
  --   inventory_cost_per_unit  = latest partcost.avgCost (inventory average)
  --   last_order_cost_per_unit = newest poitem.unitCost (last price paid)
  -- For owner='customer' both are forced to 0 at ingest — see the sync route.
  inventory_cost_per_unit   numeric,
  last_order_cost_per_unit  numeric,
  -- Source UOM each cost was converted from ("ea", "cs", "m", …).
  inventory_cost_uom        text,
  last_order_cost_uom       text,

  -- App-owned. Drives which BOM slot a component defaults into.
  category                  text check (category in (
                              'bottle','closure','liner','neckband','sleeve',
                              'label','carton','insert','safety_seal',
                              'master_box','other'
                            ) or category is null),
  notes                     text,
  active                    boolean not null default true,
  source                    text not null default 'manual'
    check (source in ('fishbowl','manual')),
  synced_at                 timestamptz,
  updated_at                timestamptz default now(),
  updated_by_email          text
);

comment on table public.packaging_components is
  'Fishbowl packaging parts (-PK-/-LL-/-UC-) for the bottle costing calculator. PC- prefix = PharmaCenter buys it; CA- prefix = customer asset, always $0.';
comment on column public.packaging_components.owner is
  'pharmacenter = PC- prefixed part, real cost applies. customer = CA- prefixed part, free issue: cost is always 0 and the BOM row is a KNOWN zero, not a missing cost.';
comment on column public.packaging_components.kind is
  'Fishbowl part-number infix: pk = bottles/caps/master boxes, ll = labels, uc = unit cartons / IFCs.';
comment on column public.packaging_components.inventory_cost_per_unit is
  'Cost per EACH (not per kg). Forced to 0 on ingest when owner = customer.';
comment on column public.packaging_components.category is
  'Curated in the app, never overwritten by sync. Decides which bill-of-materials slot the component defaults into.';

-- Auto-bump updated_at on any change.
create or replace function public.packaging_components_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists packaging_components_touch on public.packaging_components;
create trigger packaging_components_touch
  before update on public.packaging_components
  for each row execute function public.packaging_components_touch_updated_at();

-- Search + filter helpers.
create index if not exists packaging_components_name_lower_idx
  on public.packaging_components (lower(name));
create index if not exists packaging_components_fp_code_idx
  on public.packaging_components (fp_code);
create index if not exists packaging_components_kind_idx
  on public.packaging_components (kind) where active;
create index if not exists packaging_components_category_idx
  on public.packaging_components (category) where active;

-- ============================================================
-- 2. RLS — identical shape to raw_materials
-- ============================================================
alter table public.packaging_components enable row level security;

-- Drop any prior policies so re-running this script is idempotent.
drop policy if exists packaging_components_select_pharmacenter on public.packaging_components;
drop policy if exists packaging_components_insert_admin on public.packaging_components;
drop policy if exists packaging_components_update_admin on public.packaging_components;

-- Any signed-in @pharmacenterusa.com user can read.
create policy packaging_components_select_pharmacenter on public.packaging_components
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- Only admins (rows in public.admins) can insert / update via the API.
-- The Fishbowl sync uses the service-role key and bypasses RLS entirely.
create policy packaging_components_insert_admin on public.packaging_components
  for insert with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );

create policy packaging_components_update_admin on public.packaging_components
  for update using (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  ) with check (
    exists (select 1 from public.admins where lower(email) = lower(auth.email()))
  );

-- ============================================================
-- 3. No seed
--
-- Unlike raw_materials (which was seeded with the NB-26 formula so the
-- calculator had something to chew on before the first sync), packaging
-- components come entirely from Fishbowl. Run the sync to populate.
-- ============================================================
