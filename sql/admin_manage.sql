-- Lets admins add and remove other admins from the /admin page.
-- Existing policies should already cover read; this adds insert + delete
-- gated on "the caller is in the admins table".

alter table public.admins enable row level security;

-- Anyone signed-in can read the roster (UI shows who's an admin).
drop policy if exists "admins_read_for_pharmacenter" on public.admins;
create policy "admins_read_for_pharmacenter" on public.admins
  for select
  to authenticated
  using ((auth.jwt() ->> 'email') like '%@pharmacenterusa.com');

-- Only existing admins can add new admins.
drop policy if exists "admins_insert_by_admin" on public.admins;
create policy "admins_insert_by_admin" on public.admins
  for insert
  to authenticated
  with check (
    exists (select 1 from public.admins where email = (auth.jwt() ->> 'email'))
  );

-- Only existing admins can remove admins. We don't block self-deletion;
-- the API layer can refuse that case so the user doesn't lock themselves
-- out of the admin panel.
drop policy if exists "admins_delete_by_admin" on public.admins;
create policy "admins_delete_by_admin" on public.admins
  for delete
  to authenticated
  using (
    exists (select 1 from public.admins where email = (auth.jwt() ->> 'email'))
  );
