-- v49.1: which PharmaCenter app a feedback post came from, shown as a
-- small note under each comment on the merged /feedback inbox.
-- All pre-existing rows predate the merge and were posted from the
-- quote app, so the default backfills them correctly.
-- Allowed values (enforced app-side): 'quote' | 'formulas' | 'packing-list'.
alter table public.feedback
  add column if not exists app text not null default 'quote';
