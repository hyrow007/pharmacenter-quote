-- v58: ADP labor rates for the Costing tab's Direct Labor Costs card.
--
-- Fed by the nightly server sync (adp-sync.mjs — parses the scheduled
-- ADP report export and POSTs to /api/sync/labor-rates). ADP owns:
-- name, department, hourly_rate, active. App-side overlays can come
-- later (e.g. burden multiplier).

create table if not exists public.labor_rates (
  id uuid primary key default gen_random_uuid(),
  adp_id text not null unique,          -- ADP associate/position ID (upsert key)
  name text not null,
  department text,
  hourly_rate numeric,                  -- base hourly $ from ADP
  active boolean not null default true,
  source text not null default 'adp',
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.labor_rates is
  'Labor rates synced nightly from the scheduled ADP report export.';

alter table public.labor_rates enable row level security;

-- Same access pattern as raw_materials: any signed-in company user can
-- read; writes only via the service-role sync endpoint.
drop policy if exists "labor_rates_select" on public.labor_rates;
create policy "labor_rates_select" on public.labor_rates
  for select using (
    auth.jwt() ->> 'email' like '%@pharmacenterusa.com'
  );
