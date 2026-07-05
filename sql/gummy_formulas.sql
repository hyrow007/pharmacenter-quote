-- Gummy formulas catalog + version history for the decoupled Formula tool.
--
-- Two tables:
--   gummy_formulas         — one row per PC-BK gummy design (or TBD, if
--                            still in R&D and no FP code assigned yet).
--                            Owns identity: name, pc_bk_code, shape,
--                            flavor. Points to its latest version via
--                            latest_version_num for fast reads.
--   gummy_formula_versions — immutable snapshots of the recipe + batch
--                            params. Every meaningful edit (ingredient
--                            change, batch param change) creates a new
--                            version. Workflows pin (formula_id,
--                            version_num) so their historical quote is
--                            reproducible even after the catalog moves on.
--
-- Identity-only edits (renaming a formula, swapping the shape, retyping
-- the flavor) mutate the gummy_formulas row directly and do NOT create a
-- version — they're presentation metadata, not recipe changes.
--
-- Run me in the Supabase SQL Editor on the shared project (the same one
-- that holds vendors / products / customers / workflows / raw_materials).

-- ============================================================
-- 1. gummy_formulas (catalog)
-- ============================================================
create table if not exists public.gummy_formulas (
  id                   uuid primary key default gen_random_uuid(),
  -- Fishbowl FP code — the PC-BK-{n} pattern. Nullable so an R&D formula
  -- can live in the catalog before a Fishbowl code is assigned. When the
  -- code is filled, it must be unique.
  pc_bk_code           text unique,
  name                 text not null,
  -- Canonical shape picklist enforced client-side (Bear, Worm, Ring, Ball,
  -- Cube, Heart, Custom). Kept as text so the picklist can grow without
  -- a schema migration.
  shape                text not null default 'Custom',
  -- Free-form flavor text — no picklist gatekeeping. Duplicates and
  -- variants are the rep's call.
  flavor               text,
  -- Soft-delete flag. Existing quotes stay referenceable via the pinned
  -- version even when the catalog entry is hidden from the picker.
  active               boolean not null default true,
  -- Convenience pointer to the newest version so a catalog list can show
  -- "current version: v4" without joining. Updated by the API on every
  -- new version insert.
  latest_version_num   integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by_email     text,
  updated_by_email     text
);

comment on table public.gummy_formulas is
  'Catalog of gummy product designs (PC-BK-{n}). One row per distinct formula. Recipe + batch params live in gummy_formula_versions so workflows can pin an exact snapshot.';
comment on column public.gummy_formulas.pc_bk_code is
  'Fishbowl FP code, e.g. PC-BK-247. Nullable = TBD (R&D design not yet FP-coded).';
comment on column public.gummy_formulas.shape is
  'Bear / Worm / Ring / Ball / Cube / Heart / Custom. Descriptive only — does not drive math.';
comment on column public.gummy_formulas.flavor is
  'Free-text flavor description. Descriptive only — does not drive math.';
comment on column public.gummy_formulas.latest_version_num is
  'Number of the most-recent gummy_formula_versions row for this formula. Convenience denorm — the source of truth is still the max(version_num) in the versions table.';

-- Auto-bump updated_at on any change to the identity row.
create or replace function public.gummy_formulas_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists gummy_formulas_touch on public.gummy_formulas;
create trigger gummy_formulas_touch
  before update on public.gummy_formulas
  for each row execute function public.gummy_formulas_touch_updated_at();

-- Search + filter indexes.
create index if not exists gummy_formulas_name_lower_idx
  on public.gummy_formulas (lower(name));
create index if not exists gummy_formulas_shape_idx
  on public.gummy_formulas (shape);
create index if not exists gummy_formulas_active_idx
  on public.gummy_formulas (active);

-- ============================================================
-- 2. gummy_formula_versions (immutable recipe snapshots)
-- ============================================================
create table if not exists public.gummy_formula_versions (
  id                       uuid primary key default gen_random_uuid(),
  formula_id               uuid not null references public.gummy_formulas(id) on delete cascade,
  version_num              integer not null,

  -- Bench-top reference batch. All rep-facing math anchors on this so
  -- lab notebooks and the app agree on what "the formula" is. 250 g
  -- default reflects PharmaCenter R&D convention.
  bench_batch_g            numeric not null default 250
    check (bench_batch_g > 0),

  -- Scale-up realism knobs (mirrors the old inline board's DEFAULTS).
  batch_kg                 numeric not null default 100
    check (batch_kg > 0),
  batches_per_day          numeric not null default 6
    check (batches_per_day > 0),
  fixed_loss_kg_per_day    numeric not null default 20
    check (fixed_loss_kg_per_day >= 0),
  gummy_piece_weight_g     numeric not null default 3.0
    check (gummy_piece_weight_g > 0),
  -- Wet cast piece weight — mass of one gummy right out of the depositor,
  -- before drying. Higher than the finished (dried) piece weight because
  -- the wet gummy still carries water. Used to derive per-piece → per-batch
  -- amounts for label-claim-driven Secondary Blend rows, since the bench
  -- batch is measured wet even though active mass survives drying.
  -- Default 3.5 g vs. the 3.0 g finished default reflects typical PC bear
  -- moulds. Existing rows migrate via the ALTER TABLE at the bottom of
  -- this file.
  wet_cast_piece_weight_g  numeric not null default 3.5
    check (wet_cast_piece_weight_g > 0),
  yield_pct                numeric not null default 100
    check (yield_pct > 0 and yield_pct <= 100),

  -- Ingredient list as JSONB. Array of {id, rawMaterialId, customName,
  -- pctInFinished, costPerKgOverride, solidsOverride, notes}. See
  -- /lib/formulas.ts for the exact TS type.
  ingredients              jsonb not null default '[]'::jsonb,

  -- Version-level notes ("why did I bump the pectin?"). Optional free text.
  notes                    text,

  created_at               timestamptz not null default now(),
  created_by_email         text,

  -- One row per (formula, version_num). API layer allocates the next
  -- number when creating a version.
  unique (formula_id, version_num)
);

comment on table public.gummy_formula_versions is
  'Immutable snapshots of a gummy formula recipe + batch params. Workflows pin (formula_id, version_num) to keep their quote reproducible.';
comment on column public.gummy_formula_versions.bench_batch_g is
  'Reference batch weight in grams. Default 250 g matches PC lab convention.';
comment on column public.gummy_formula_versions.ingredients is
  'JSONB array. Each row = {id: string, rawMaterialId: uuid|null, customName: string|null, pctInFinished: number, costPerKgOverride: number|null, solidsOverride: number|null, notes: string|null}. pctInFinished is percent of finished-piece weight (0-100).';

-- Fast lookup of the pinned version for a workflow, and fast "give me the
-- latest version for formula X" for the editor's initial load.
create index if not exists gummy_formula_versions_formula_id_idx
  on public.gummy_formula_versions (formula_id);
create index if not exists gummy_formula_versions_formula_latest_idx
  on public.gummy_formula_versions (formula_id, version_num desc);

-- ============================================================
-- 3. Keep latest_version_num in sync when new versions land.
-- ============================================================
-- Any new version row bumps its parent formula's convenience pointer AND
-- touches updated_at (via the touch trigger fired by the update).
create or replace function public.gummy_formula_versions_sync_latest()
returns trigger language plpgsql as $$
begin
  update public.gummy_formulas
     set latest_version_num = new.version_num
   where id = new.formula_id
     and latest_version_num < new.version_num;
  return new;
end;
$$;

drop trigger if exists gummy_formula_versions_sync_latest on public.gummy_formula_versions;
create trigger gummy_formula_versions_sync_latest
  after insert on public.gummy_formula_versions
  for each row execute function public.gummy_formula_versions_sync_latest();

-- Versions are meant to be immutable. Block updates + deletes at the DB
-- level so nobody (including us via the API) accidentally rewrites
-- history. If a version genuinely needs to be scrapped, delete via
-- service-role key.
create or replace function public.gummy_formula_versions_no_mutate()
returns trigger language plpgsql as $$
begin
  raise exception 'gummy_formula_versions rows are immutable — insert a new version instead';
end;
$$;

drop trigger if exists gummy_formula_versions_block_update on public.gummy_formula_versions;
create trigger gummy_formula_versions_block_update
  before update on public.gummy_formula_versions
  for each row execute function public.gummy_formula_versions_no_mutate();

-- ============================================================
-- 4. RLS
-- ============================================================
-- For now anyone signed in with an @pharmacenterusa.com email can read
-- and write. When we add role-gating (R&D vs sales) later, tighten the
-- insert/update policies.
alter table public.gummy_formulas enable row level security;
alter table public.gummy_formula_versions enable row level security;

-- gummy_formulas policies -------------------------------------
drop policy if exists gummy_formulas_select on public.gummy_formulas;
drop policy if exists gummy_formulas_insert on public.gummy_formulas;
drop policy if exists gummy_formulas_update on public.gummy_formulas;

create policy gummy_formulas_select on public.gummy_formulas
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formulas_insert on public.gummy_formulas
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formulas_update on public.gummy_formulas
  for update using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  ) with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- gummy_formula_versions policies -----------------------------
drop policy if exists gummy_formula_versions_select on public.gummy_formula_versions;
drop policy if exists gummy_formula_versions_insert on public.gummy_formula_versions;

create policy gummy_formula_versions_select on public.gummy_formula_versions
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formula_versions_insert on public.gummy_formula_versions
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- Note: no update policy on gummy_formula_versions — the no-mutate
-- trigger above blocks updates for everyone including admins. If we ever
-- need to fix a version, do it via service-role key with the trigger
-- disabled for the transaction.

-- ============================================================
-- 5. Idempotent migrations for existing production databases.
-- ============================================================
-- Re-run this file on a fresh DB and these ADDs are no-ops (the columns
-- already exist above). Re-run on an existing DB and they backfill the
-- new columns onto rows that predate them, with a safe default so the
-- NOT NULL constraint can be added.
--
-- Adding wet_cast_piece_weight_g (Feb 2026) — the wet cast weight lets
-- the label-claim → Secondary Blend derivation compute pieces per bench
-- batch against the wet-measured batch instead of the finished/dried
-- piece weight. Active mass survives drying, so mass-per-finished-gummy
-- equals mass-per-wet-cast-piece; the bench math needs the wet piece
-- weight to convert benchBatchG → piecesPerBatch correctly.
alter table public.gummy_formula_versions
  add column if not exists wet_cast_piece_weight_g numeric;

-- Backfill any nulls left over from the ADD (Supabase populates existing
-- rows with NULL first; we can't add NOT NULL + DEFAULT + CHECK in one
-- shot without either backfilling first or accepting the default takes).
update public.gummy_formula_versions
   set wet_cast_piece_weight_g = 3.5
 where wet_cast_piece_weight_g is null;

-- Set the default so future INSERTs that omit the field get 3.5.
alter table public.gummy_formula_versions
  alter column wet_cast_piece_weight_g set default 3.5;

-- Now enforce NOT NULL now that every row has a value.
alter table public.gummy_formula_versions
  alter column wet_cast_piece_weight_g set not null;

-- Add the > 0 check idempotently. The DO block swallows the
-- duplicate-object error so re-runs are safe.
do $$
begin
  alter table public.gummy_formula_versions
    add constraint gummy_formula_versions_wet_cast_positive
    check (wet_cast_piece_weight_g > 0);
exception
  when duplicate_object then null;
end;
$$;
