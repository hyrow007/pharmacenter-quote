-- gummy_formula_files — file attachments on a gummy formula (v73).
--
-- Each formula gets a "Files" card where the team parks CoAs, customer
-- specs, label artwork, lab reports. Files attach at the FORMULA level
-- (not per-version — documents shouldn't fork on every save). Binary
-- lives in the `formula-files` storage bucket; this table is the
-- listing/metadata layer the UI reads.
--
-- Access model mirrors gummy_formula_notes: domain-gated RLS
-- (@pharmacenterusa.com). Unlike notes, DELETE is domain-wide rather
-- than author-only — pruning a stale CoA someone else uploaded is
-- routine ops work; the UI double-confirms instead.
--
-- The bucket is public-read like quote-attachments: paths are
-- uuid-prefixed so knowing the bucket name discovers nothing, and
-- public URLs keep downloads dependency-free (same tradeoff the quote
-- flow already accepted).

-- ============================================================
-- 1. Table
-- ============================================================
create table if not exists public.gummy_formula_files (
  id                uuid primary key default gen_random_uuid(),
  formula_id        uuid not null references public.gummy_formulas(id) on delete cascade,
  filename          text not null,
  storage_path      text not null,
  size_bytes        bigint not null default 0,
  mime_type         text,
  uploaded_by_email text not null,
  uploaded_at       timestamptz not null default now()
);

comment on table public.gummy_formula_files is
  'File attachments on a gummy formula. Binary lives in the formula-files storage bucket.';

create index if not exists gummy_formula_files_formula_id_uploaded_at_idx
  on public.gummy_formula_files (formula_id, uploaded_at desc);

-- ============================================================
-- 2. Table RLS
-- ============================================================
alter table public.gummy_formula_files enable row level security;

drop policy if exists gummy_formula_files_select on public.gummy_formula_files;
drop policy if exists gummy_formula_files_insert on public.gummy_formula_files;
drop policy if exists gummy_formula_files_delete on public.gummy_formula_files;

create policy gummy_formula_files_select on public.gummy_formula_files
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formula_files_insert on public.gummy_formula_files
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
    and uploaded_by_email = auth.email()
  );

create policy gummy_formula_files_delete on public.gummy_formula_files
  for delete using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

-- ============================================================
-- 3. Storage bucket + policies
-- ============================================================
insert into storage.buckets (id, name, public)
values ('formula-files', 'formula-files', true)
on conflict (id) do nothing;

drop policy if exists formula_files_upload on storage.objects;
drop policy if exists formula_files_read on storage.objects;
drop policy if exists formula_files_delete on storage.objects;

create policy formula_files_upload on storage.objects
  for insert with check (
    bucket_id = 'formula-files'
    and auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy formula_files_read on storage.objects
  for select using (bucket_id = 'formula-files');

create policy formula_files_delete on storage.objects
  for delete using (
    bucket_id = 'formula-files'
    and auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );
