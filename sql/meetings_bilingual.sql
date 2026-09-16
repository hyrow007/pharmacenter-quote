-- Bilingual retrofit: add Spanish variants alongside the canonical
-- English fields on meeting_sessions and meeting_so_notes, plus
-- structured mismatch flags so ⚠ warnings become chrome (localized in
-- the UI) instead of appended text stuck in one language.
--
-- Run me in the shared "Packing-List" Supabase project.

alter table public.meeting_sessions
  add column if not exists summary_md_es     text,
  add column if not exists other_business_es jsonb;

alter table public.meeting_so_notes
  add column if not exists note_md_es        text,
  add column if not exists action_items_es   jsonb,
  add column if not exists customer_mismatch boolean not null default false,
  add column if not exists customer_hint     text,
  add column if not exists product_mismatch  boolean not null default false,
  add column if not exists product_hint      text;
