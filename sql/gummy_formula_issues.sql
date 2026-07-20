-- gummy_formula_issues — official version numbers, decoupled from saves.
--
-- v54: Saving a formula keeps cutting immutable revision rows in
-- gummy_formula_versions (version_num keeps incrementing internally as a
-- REVISION counter, and every save is still audit-logged), but the
-- human-facing version number no longer bumps on save. Instead the
-- operator clicks "Issue", which appends a row here mapping the next
-- official issue number to the revision it stamps.
--
--   issue_num    — the official version the app displays (v29, v30, …)
--   revision_num — the gummy_formula_versions.version_num it points at
--
-- Append-only, mirroring the audit table: issuing can never rewrite
-- history, and the (formula_id, issue_num) unique key makes double-issue
-- impossible.

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.gummy_formula_issues (
  id               uuid primary key default gen_random_uuid(),
  formula_id       uuid not null references public.gummy_formulas(id) on delete cascade,
  issue_num        integer not null,
  revision_num     integer not null,
  issued_by_email  text,
  issued_at        timestamptz not null default now(),
  note             text,
  unique (formula_id, issue_num)
);

comment on table public.gummy_formula_issues is
  'Official issued version numbers for gummy formulas — appended by the Issue button; saves alone no longer bump the visible version.';

create index if not exists gummy_formula_issues_formula_idx
  on public.gummy_formula_issues (formula_id, issue_num desc);

-- ============================================================
-- 2. Immutability — block updates + deletes at the DB level
-- ============================================================
create or replace function public.gummy_formula_issues_no_mutate()
returns trigger language plpgsql as $$
begin
  raise exception 'gummy_formula_issues rows are immutable';
end;
$$;

drop trigger if exists gummy_formula_issues_block_update on public.gummy_formula_issues;
create trigger gummy_formula_issues_block_update
  before update or delete on public.gummy_formula_issues
  for each row execute function public.gummy_formula_issues_no_mutate();

-- ============================================================
-- 3. RLS
-- ============================================================
alter table public.gummy_formula_issues enable row level security;

drop policy if exists gummy_formula_issues_select on public.gummy_formula_issues;
drop policy if exists gummy_formula_issues_insert on public.gummy_formula_issues;

create policy gummy_formula_issues_select on public.gummy_formula_issues
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formula_issues_insert on public.gummy_formula_issues
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- ============================================================
-- 4. Audit kinds — allow 'issued' events on the timeline
-- ============================================================
alter table public.gummy_formula_audit
  drop constraint if exists gummy_formula_audit_kind_check;
alter table public.gummy_formula_audit
  add constraint gummy_formula_audit_kind_check
  check (kind in ('created', 'identity', 'version', 'issued'));

-- ============================================================
-- 5. Baseline — existing formulas keep their current numbers
-- ============================================================
-- Every formula's current latest revision becomes its issued baseline,
-- so F0001 stays v29 and the first Issue after this migration cuts v30.
insert into public.gummy_formula_issues (formula_id, issue_num, revision_num, issued_by_email, note)
select id, latest_version_num, latest_version_num, 'migration@pharmacenterusa.com',
       'Baseline — numbering carried over from the save-per-version era.'
from public.gummy_formulas
where latest_version_num > 0
on conflict (formula_id, issue_num) do nothing;
