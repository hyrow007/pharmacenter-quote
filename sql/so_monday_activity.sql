-- Cache of Monday.com "Open Sales Orders" board activity per SO.
--
-- Populated by POST /api/sync/monday (bearer-auth, scheduled) — the
-- meetings hub reads from here rather than hitting Monday's API on every
-- page render. One row per SO (item.name in Monday). Latest updates
-- (comments/posts on the item) live in the `updates` jsonb newest-first.
--
-- Monday board: "Open Sales Orders", id 18389208010, workspace 13384272.
-- Item name = SO number, matching public.fishbowl_sales_orders.so_number.
--
-- Run me in the shared "Packing-List" Supabase project SQL editor.

create table if not exists public.so_monday_activity (
  so_number         text primary key,       -- item.name in Monday
  monday_item_id    bigint not null,        -- Monday item id
  monday_url        text,                   -- direct link to the item
  status            text,                   -- status column value ("In Progress" etc.)
  status_color      text,                   -- optional color hex for the pill
  item_updated_at   timestamptz,            -- Monday's updated_at on the item
  updates           jsonb not null default '[]'::jsonb,
  -- shape: [{ id, text_body, created_at, creator_name }] newest-first
  last_synced_at    timestamptz not null default now()
);

create index if not exists so_monday_activity_last_synced_idx
  on public.so_monday_activity (last_synced_at desc);

alter table public.so_monday_activity enable row level security;

drop policy if exists "so_monday_activity read for authenticated" on public.so_monday_activity;
create policy "so_monday_activity read for authenticated"
  on public.so_monday_activity for select
  to authenticated
  using (true);
-- Writes go through the service role via /api/sync/monday.
