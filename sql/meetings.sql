-- Meetings hub — extensible schema for meeting.pharmacenter.app.
--
-- The meeting subdomain hosts a hub of recurring meetings. Sales Orders is
-- the first one (weekly production/sales review); more types (production,
-- leadership, etc.) drop in as rows in `meeting_types` without a code
-- change to the hub itself.
--
-- Data flow:
--   Plaud API (recorder) → POST /api/plaud/webhook → meeting_sessions row
--     → per-SO notes extracted into meeting_so_notes (each snapshotting
--       the live Fishbowl state at ingest time for cross-reference).
--
-- Cross-reference against Fishbowl:
--   meeting_so_notes.fishbowl_snapshot captures qty/status/scheduled ship
--   at the moment of ingest. Views compare that snapshot against the
--   current fishbowl_sales_orders row to surface deltas (moved dates,
--   partial fulfillment since, closed since, etc.).
--
-- All writes come from the service-role (Plaud ingest + manual editor
-- routes); reads are open to any authenticated @pharmacenterusa.com
-- session via RLS + the app-level email guard.
--
-- Run me in the Supabase SQL Editor on the shared "Packing-List" project
-- (same one that holds fishbowl_sales_orders, gummy_formulas, etc.).

-- ============================================================
-- 1. meeting_types — the hub's tiles
-- ============================================================
create table if not exists public.meeting_types (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,         -- URL segment, e.g. "sales-orders"
  name         text not null,                -- "Sales Orders"
  tagline      text,                         -- one-liner on the hub card
  cadence      text,                         -- "Weekly", "Bi-weekly", …
  active       boolean not null default true,
  sort_order   int not null default 100,
  created_at   timestamptz not null default now()
);

-- Seed the first meeting type. Idempotent.
insert into public.meeting_types (slug, name, tagline, cadence, sort_order)
values (
  'sales-orders',
  'Sales Orders',
  'Weekly review of open Fishbowl sales orders — status, ship dates, and action items captured from the Plaud recording.',
  'Weekly',
  10
)
on conflict (slug) do nothing;

-- ============================================================
-- 2. meeting_sessions — one per recorded/held meeting
-- ============================================================
create table if not exists public.meeting_sessions (
  id                uuid primary key default gen_random_uuid(),
  meeting_type_id   uuid not null references public.meeting_types(id) on delete cascade,
  session_date      date not null,          -- the date the meeting was held
  source            text not null default 'manual',  -- 'plaud' | 'manual'
  plaud_recording_id text,                  -- external id from Plaud, when source='plaud'
  transcript_url    text,                   -- pointer to raw transcript (if any)
  summary_md        text,                   -- summary/notes for the whole session
  attendees         text[] not null default '{}',
  -- Cross-cutting topics that don't tie to a single SO (Shandong load,
  -- line 2 sequence, film/cash question, etc.). Populated by the Plaud
  -- webhook via extractOtherBusinessFromSummary(). Shape:
  --   [{ title: string, note_md: string, action_items: [{...}] }]
  other_business    jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Add for existing installations.
alter table public.meeting_sessions
  add column if not exists other_business jsonb not null default '[]'::jsonb;

create index if not exists meeting_sessions_type_date_idx
  on public.meeting_sessions (meeting_type_id, session_date desc);
create index if not exists meeting_sessions_plaud_idx
  on public.meeting_sessions (plaud_recording_id)
  where plaud_recording_id is not null;

-- ============================================================
-- 3. meeting_so_notes — per-SO commentary from a session
-- ============================================================
-- One row per (session, SO) pair. Everything said about SO 50123 in the
-- Sep 15 meeting lives in one row; the raw quote(s) go in note_md, the
-- structured follow-ups in action_items[], and the SO's live state as of
-- the meeting in fishbowl_snapshot. Later views diff fishbowl_snapshot
-- against the current fishbowl_sales_orders row to show what has changed.
create table if not exists public.meeting_so_notes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.meeting_sessions(id) on delete cascade,
  so_number    text not null,                     -- matches fishbowl_sales_orders.so_number
  note_md      text,                              -- what was said, formatted markdown
  action_items jsonb not null default '[]'::jsonb,  -- [{ text, owner, due_date, done }]
  status_flag  text,                              -- optional 'blocked' | 'at_risk' | 'on_track'
  -- Snapshot of the Fishbowl row at ingest time — used for cross-reference.
  -- Shape mirrors the fields we care about (see /api/sales-orders):
  --   { status_id, status_name, is_open, customer_name, customer_po,
  --     salesman, date_first_ship, subtotal, total_price,
  --     items_sale: [{ product_num, qty_ordered, qty_fulfilled, qty_picked }] }
  fishbowl_snapshot jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists meeting_so_notes_session_idx
  on public.meeting_so_notes (session_id);
create index if not exists meeting_so_notes_so_number_idx
  on public.meeting_so_notes (so_number);

-- One (session, SO) row max — repeat mentions in the same meeting stack
-- into note_md; ingest UPSERTs on this key.
create unique index if not exists meeting_so_notes_session_so_unique
  on public.meeting_so_notes (session_id, so_number);

-- ============================================================
-- 4. RLS — authenticated read, service-role write
-- ============================================================
alter table public.meeting_types    enable row level security;
alter table public.meeting_sessions enable row level security;
alter table public.meeting_so_notes enable row level security;

drop policy if exists "meeting_types read for authenticated"    on public.meeting_types;
drop policy if exists "meeting_sessions read for authenticated" on public.meeting_sessions;
drop policy if exists "meeting_so_notes read for authenticated" on public.meeting_so_notes;

create policy "meeting_types read for authenticated"
  on public.meeting_types for select to authenticated using (true);
create policy "meeting_sessions read for authenticated"
  on public.meeting_sessions for select to authenticated using (true);
create policy "meeting_so_notes read for authenticated"
  on public.meeting_so_notes for select to authenticated using (true);

-- No insert/update/delete policies on purpose. The Plaud ingester and any
-- future editor endpoints write with the service-role key (bypasses RLS).
