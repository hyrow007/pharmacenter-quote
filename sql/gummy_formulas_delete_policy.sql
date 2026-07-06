-- Add an admin-only DELETE policy to public.gummy_formulas.
--
-- Bug: the catalog's admin Delete button appeared to work (row vanished
-- from the UI) but the row was back after a page refresh. Root cause —
-- gummy_formulas RLS only had SELECT / INSERT / UPDATE policies, so any
-- DELETE issued through the API's user-scoped Supabase client was
-- silently blocked by row-level security (0 rows affected, no error
-- returned to the caller).
--
-- This migration adds a DELETE policy that mirrors the existing admin
-- pattern used by admins_delete_by_admin and feedback: the caller must
-- have an @pharmacenterusa.com email AND be listed in public.admins.
-- The API route also runs isAdmin() before issuing the DELETE, so
-- non-admins get a 403 before the query ever hits the DB — this policy
-- is the defense-in-depth layer that catches any missed application-
-- level check.
--
-- Cascade: child rows in gummy_formula_versions, gummy_formula_audit,
-- and gummy_formula_notes reference gummy_formulas(id) with
-- `on delete cascade`, so a successful parent delete cleans up its
-- history in one shot without any extra policies on the child tables.
--
-- Idempotent — safe to re-run.

drop policy if exists gummy_formulas_delete on public.gummy_formulas;

create policy gummy_formulas_delete on public.gummy_formulas
  for delete using (
    auth.email() is not null
    and auth.email() like '%@pharmacenterusa.com'
    and exists (
      select 1
      from public.admins
      where email = (auth.jwt() ->> 'email')
    )
  );
