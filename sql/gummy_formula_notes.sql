-- gummy_formula_notes — user-authored notes attached to a gummy formula.
--
-- One row per note. Notes are read + append only from the app: the UI
-- exposes a compose box and a timeline of everyone's notes attributed to
-- whoever wrote them, but no edit or delete affordance. The domain-gated
-- RLS policies mirror gummy_formula_audit so the two features share the
-- same access model.

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.gummy_formula_notes (
  id           uuid primary key default gen_random_uuid(),
  formula_id   uuid not null references public.gummy_formulas(id) on delete cascade,
  body         text not null,
  author_email text not null,
  created_at   timestamptz not null default now()
);

comment on table public.gummy_formula_notes is
  'User-authored notes on a gummy formula. Read + append only from the app.';

-- Fast timeline reads for the editor UI.
create index if not exists gummy_formula_notes_formula_id_created_at_idx
  on public.gummy_formula_notes (formula_id, created_at desc);

-- ============================================================
-- 2. RLS
-- ============================================================
alter table public.gummy_formula_notes enable row level security;

drop policy if exists gummy_formula_notes_select on public.gummy_formula_notes;
drop policy if exists gummy_formula_notes_insert on public.gummy_formula_notes;

create policy gummy_formula_notes_select on public.gummy_formula_notes
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formula_notes_insert on public.gummy_formula_notes
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
    and author_email = auth.email()
  );

-- No update / delete policy — notes are append-only from the app. Manual
-- cleanup can be done from the SQL editor as a superuser if ever needed.
