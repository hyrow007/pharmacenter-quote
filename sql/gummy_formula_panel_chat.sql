-- gummy_formula_panel_chat_messages — persisted Panel Assistant chat
-- (v83.9). The Supplement Facts tab's assistant conversation used to be
-- screen-local React state, gone on every reload; it now attaches to
-- the FORMULA (not the version — chat is collaboration, not spec) the
-- same way notes do.
--
-- Attachments are NOT stored — only their filenames for display. The
-- base64 payloads ride one request to the model and are discarded;
-- anything worth keeping belongs in the formula's Files card.
--
-- RLS mirrors gummy_formula_files: domain-gated select/insert, insert
-- pins author_email to the session, domain-wide delete (clearing a
-- stale chat is routine).

create table if not exists public.gummy_formula_panel_chat_messages (
  id               uuid primary key default gen_random_uuid(),
  formula_id       uuid not null references public.gummy_formulas(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  attachment_names text[],
  author_email     text not null,
  created_at       timestamptz not null default now()
);

comment on table public.gummy_formula_panel_chat_messages is
  'Panel Assistant chat history, per formula. Assistant turns carry the asking user''s email as author.';

create index if not exists gummy_formula_panel_chat_formula_created_idx
  on public.gummy_formula_panel_chat_messages (formula_id, created_at);

alter table public.gummy_formula_panel_chat_messages enable row level security;

drop policy if exists gummy_formula_panel_chat_select on public.gummy_formula_panel_chat_messages;
drop policy if exists gummy_formula_panel_chat_insert on public.gummy_formula_panel_chat_messages;
drop policy if exists gummy_formula_panel_chat_delete on public.gummy_formula_panel_chat_messages;

create policy gummy_formula_panel_chat_select on public.gummy_formula_panel_chat_messages
  for select using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );

create policy gummy_formula_panel_chat_insert on public.gummy_formula_panel_chat_messages
  for insert with check (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
    and author_email = auth.email()
  );

create policy gummy_formula_panel_chat_delete on public.gummy_formula_panel_chat_messages
  for delete using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
  );
