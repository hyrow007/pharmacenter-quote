-- Open sales orders, synced nightly from Fishbowl.
--
-- Named fishbowl_sales_orders because public.sales_orders ALREADY EXISTS
-- and belongs to the Packing List app (its packing-list ↔ SO linkage,
-- uuid ids + created_by). Do not touch that table; this one is a pure
-- Fishbowl mirror keyed by Fishbowl's own so.id.
--
-- Purpose: give Claude sessions (and eventually the app) a queryable list
-- of OPEN Fishbowl sales orders without touching the office server. The
-- sender is the sales-orders block in fishbowl-sync.mjs; the receiver is
-- POST /api/sync/sales-orders; the consumer is GET /api/sales-orders.
--
-- One row per SALES ORDER. Line items ride in an `items` jsonb array —
-- readers filter/flatten as they like, and we never chase a second table.
--
-- Which orders land here: Fishbowl statusId 10 (Estimate), 20 (Issued),
-- 25 (In Progress). `is_open` is true for 20/25 only. Orders that close,
-- void, or ship out of that set simply stop arriving; the finalize step
-- of each sync run flips the leftovers to is_open = false (they are kept,
-- not deleted, so "what closed since yesterday" stays answerable).
--
-- Fishbowl owns EVERY column here — there are no app-side overlays, so a
-- resync can never clobber curated data (there is none to clobber).
--
-- Run me in the Supabase SQL Editor on the shared project (the same one
-- that holds vendors / products / customers / workflows / raw_materials).

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.fishbowl_sales_orders (
  fb_so_id        bigint primary key,   -- Fishbowl so.id
  so_number       text not null,        -- Fishbowl so.num, e.g. "50123"
  status_id       int,
  status_name     text,                 -- "Issued" / "In Progress" / "Estimate"
  is_open         boolean not null default true,

  customer_name   text,
  customer_po     text,
  salesman        text,
  note            text,

  date_issued     timestamptz,
  date_created    timestamptz,
  date_first_ship timestamptz,          -- scheduled ship date on the SO
  date_last_modified timestamptz,

  subtotal        numeric,
  total_price     numeric,

  -- One entry per soitem row:
  -- { line, type_id, status_id, product_num, description, qty_ordered,
  --   qty_fulfilled, qty_picked, unit_price, total_price, date_scheduled }
  items           jsonb not null default '[]'::jsonb,

  -- Sync bookkeeping. Every batch of one nightly run shares a run id; the
  -- finalize step marks anything carrying an OLDER run id as closed.
  sync_run_id     text,
  synced_at       timestamptz not null default now()
);

create index if not exists fishbowl_sales_orders_open_idx
  on public.fishbowl_sales_orders (is_open, so_number);
create index if not exists fishbowl_sales_orders_customer_idx
  on public.fishbowl_sales_orders (customer_name);

-- ============================================================
-- 2. RLS — signed-in app users read, only the service role writes
-- ============================================================
alter table public.fishbowl_sales_orders enable row level security;

drop policy if exists "fishbowl_sales_orders read for authenticated"
  on public.fishbowl_sales_orders;
create policy "fishbowl_sales_orders read for authenticated"
  on public.fishbowl_sales_orders for select
  to authenticated
  using (true);

-- No insert/update/delete policies on purpose: the sync route writes with
-- the service-role key, which bypasses RLS. Nothing else should write.
