-- gummy_formula_audit — immutable audit log capturing every write to a
-- gummy formula so we can answer "who changed what, when, between saves".
--
-- One row per save event:
--   kind = 'created' — the formula's initial row + version 1 was written
--   kind = 'identity' — a name / pc_bk_code / shape / flavor field changed
--                       (no new version cut)
--   kind = 'version'  — a new gummy_formula_versions snapshot was cut;
--                       the corresponding version_num is stored on the row
--
-- The API layer computes a human-readable `summary` per event and a
-- structured `diff` JSONB so the timeline UI can render either.
--
-- Rows are immutable — a no-mutate trigger blocks updates + deletes.

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.gummy_formula_audit (
  id                uuid primary key default gen_random_uuid(),
  formula_id        uuid not null references public.gummy_formulas(id) on delete cascade,
  at                timestamptz not null default now(),
  by_email          text,
  kind              text not null check (kind in ('created', 'identity', 'version')),
  -- For kind='version', which version_num this event refers to. Null for
  -- 'created' + 'identity' events.
  version_num       integer,
  -- One-line human-readable summary for the timeline UI, e.g.
  -- "Renamed from 'Sour Bear' to 'Sour Green Apple Bear', changed shape from Bear to Ball"
  -- or "Cut version v3 — modified 2 ingredients"
  summary           text not null,
  -- Structured diff so the UI can expand a row to show exactly which
  -- fields moved.
  -- Identity events: { changes: [{field, from, to}, ...] }
  -- Version events:  { added: [...], removed: [...], modified: [...], paramChanges: [{field, from, to}] }
  -- Created events:  { seed: {name, shape, pcBkCode, flavor} }
  diff              jsonb not null default '{}'::jsonb
);

comment on table public.gummy_formula_audit is
  'Immutable audit log for gummy_formulas — one row per save event (create/identity/version).';
comment on column public.gummy_formula_audit.kind is
  'created = initial row + v1 written; identity = name/pc_bk_code/shape/flavor edit (no version bump); version = new gummy_formula_versions row.';

-- Fast timeline reads for the editor UI.
create index if not exists gummy_formula_audit_formula_at_idx
  on public.gummy_formula_audit (formula_id, at desc);

-- ============================================================
-- 2. Immutability — block updates + deletes at the DB level
-- ============================================================
create or replace function public.gummy_formula_audit_no_mutate()
returns trigger language plpgsql as $$
begin
  raise exception 'gummy_formula_audit rows are immutable';
end;
$$;

drop trigger if exists gummy_formula_audit_block_update on public.gummy_formula_audit;
create trigger gummy_formula_audit_block_update
  before update on public.gummy_formula_audit
  for each row execute function public.gummy_formula_audit_no_mutate();

-- ============================================================
-- 3. RLS
-- ============================================================
alter table public.gummy_formula_audit enable row level security;

drop policy if exists gummy_formula_audit_select on public.gummy_formula_audit;
drop policy if exists gummy_formula_audit_insert on public.gummy_formula_audit;

create policy gummy_formula_audit_select on public.gummy_formula_audit
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formula_audit_insert on public.gummy_formula_audit
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- No update / delete policy — the no-mutate trigger blocks those anyway,
-- but the missing policies make the intent explicit.
