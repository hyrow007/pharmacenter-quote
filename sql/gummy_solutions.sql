-- Saved solutions library.
--
-- A "solution" is a pre-mixed compound used across multiple gummy
-- formulas — e.g. "Citric Acid 50% sol" = 50% citric acid + 50% water,
-- which shows up in half the pre-cook blends we author. This table stores
-- solutions by name so any formula can pull them from a library instead
-- of re-typing the same components + %s every time.
--
-- Shape (JSONB array on components):
--   [{ id, rawMaterialId, rawMaterialFpCode, customName, pct }]
-- Percentages should sum to 100.
--
-- Solutions are name-unique (case-insensitive) so a library user picks
-- "Citric Acid 50% sol" and gets exactly one match.

create table if not exists public.gummy_solutions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  components jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_email text,
  updated_by_email text,
  constraint gummy_solutions_name_unique
    unique (name)
);

create index if not exists gummy_solutions_active_name_idx
  on public.gummy_solutions (active, lower(name));

alter table public.gummy_solutions enable row level security;

-- Any @pharmacenterusa.com user can read + write. The API route enforces
-- the domain check server-side too.
drop policy if exists gummy_solutions_select on public.gummy_solutions;
create policy gummy_solutions_select on public.gummy_solutions
  for select using (
    auth.jwt() ->> 'email' like '%@pharmacenterusa.com'
  );

drop policy if exists gummy_solutions_insert on public.gummy_solutions;
create policy gummy_solutions_insert on public.gummy_solutions
  for insert with check (
    auth.jwt() ->> 'email' like '%@pharmacenterusa.com'
  );

drop policy if exists gummy_solutions_update on public.gummy_solutions;
create policy gummy_solutions_update on public.gummy_solutions
  for update using (
    auth.jwt() ->> 'email' like '%@pharmacenterusa.com'
  );

comment on table public.gummy_solutions is
  'Reusable pre-mixed solutions (name + component percentages) that formulas can pull into their blend sections. Name-unique.';
