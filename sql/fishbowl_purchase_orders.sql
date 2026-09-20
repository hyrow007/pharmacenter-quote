-- Open purchase orders, synced nightly from Fishbowl.
--
-- Sibling of fishbowl_sales_orders (same shape, same rules): one row per
-- PO with line items folded into an `items` jsonb array, service-role
-- writes only, RLS read-only for authenticated app users.
--
-- Purpose: given an SO, show every PO that was placed against it — to
-- what vendor, when, and for what. Fishbowl links a PO line back to an
-- SO line via poitem.soItemId, so `items[*].so_number` on this table is
-- the SO the line belongs to (derived at parse time on the sync side
-- from the soitem the poItem points at).
--
-- Which POs land here: statusId 20 (Issued) / 25 (Partially Received)
-- flagged is_open=true, plus 10 (Estimate) for context. Anything else
-- (Fulfilled/Cancelled/Void/Historical) drops off after the finalize
-- step of the run flips stale rows to is_open=false, matching the SO
-- mirror's behavior.
--
-- Fishbowl owns EVERY column here — no app-side overlays, so a resync
-- can never clobber curated data.

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.fishbowl_purchase_orders (
  fb_po_id        bigint primary key,   -- Fishbowl po.id
  po_number       text not null,        -- Fishbowl po.num
  status_id       int,
  status_name     text,                 -- "Issued" / "Partial" / "Estimate"
  is_open         boolean not null default true,

  vendor_id       bigint,               -- Fishbowl vendor.id
  vendor_name     text,
  buyer           text,                 -- po.username (who placed it)

  date_issued     timestamptz,
  date_created    timestamptz,
  date_completed  timestamptz,
  date_last_modified timestamptz,

  subtotal        numeric,
  total_price     numeric,

  -- One entry per poitem row. so_number + so_item_line are set when
  -- Fishbowl's poitem.soItemId resolved to a soitem we know about, so
  -- the meetings hub can look up POs by SO cheaply:
  --   { line, product_num, description, qty_ordered, qty_fulfilled,
  --     unit_cost, total_cost, date_scheduled,
  --     so_number, so_item_line, so_item_product_num }
  items           jsonb not null default '[]'::jsonb,

  -- Denormalized set of every SO number referenced by any line item on
  -- this PO. Read side queries this with `?so_numbers.cs.["14328"]` or
  -- equivalent, so we don't have to unnest items just to find POs for
  -- one SO. Populated on the sync side from items[*].so_number.
  so_numbers      text[] not null default '{}'::text[],

  sync_run_id     text,
  synced_at       timestamptz not null default now()
);

create index if not exists fishbowl_purchase_orders_open_idx
  on public.fishbowl_purchase_orders (is_open, po_number);
create index if not exists fishbowl_purchase_orders_vendor_idx
  on public.fishbowl_purchase_orders (vendor_name);
create index if not exists fishbowl_purchase_orders_so_numbers_idx
  on public.fishbowl_purchase_orders using gin (so_numbers);

-- ============================================================
-- 2. RLS — signed-in app users read, only the service role writes
-- ============================================================
alter table public.fishbowl_purchase_orders enable row level security;

drop policy if exists "fishbowl_purchase_orders read for authenticated"
  on public.fishbowl_purchase_orders;
create policy "fishbowl_purchase_orders read for authenticated"
  on public.fishbowl_purchase_orders for select
  to authenticated
  using (true);
