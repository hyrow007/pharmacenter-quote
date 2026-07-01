-- Feedback page schema. Mirrors the Packing List app's feedback feature.
-- Run this once in the Supabase SQL Editor (the same project the Quote app
-- talks to). Idempotent — safe to re-run.

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  author_email text not null,
  body        text not null check (char_length(body) > 0)
);

create index if not exists feedback_created_at_idx
  on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Any signed-in @pharmacenterusa.com user can read every feedback row.
drop policy if exists "feedback_read_for_pharmacenter" on public.feedback;
create policy "feedback_read_for_pharmacenter" on public.feedback
  for select
  to authenticated
  using ((auth.jwt() ->> 'email') like '%@pharmacenterusa.com');

-- Same can insert, but only as themselves (no spoofing author_email).
drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own" on public.feedback
  for insert
  to authenticated
  with check (author_email = (auth.jwt() ->> 'email'));

-- Authors can delete their own posts; admins can delete anyone's.
drop policy if exists "feedback_delete_own_or_admin" on public.feedback;
create policy "feedback_delete_own_or_admin" on public.feedback
  for delete
  to authenticated
  using (
    author_email = (auth.jwt() ->> 'email')
    or exists (
      select 1 from public.admins where email = (auth.jwt() ->> 'email')
    )
  );
