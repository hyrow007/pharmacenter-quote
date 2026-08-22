-- Self-healing category for packaging_components.
--
-- THE PROBLEM THIS SOLVES
--
-- When someone adds a new part in Fishbowl it flows: Fishbowl -> sync
-- script -> /api/sync/packaging-components -> upsert. The route
-- deliberately omits `category` from the payload, because that omission is
-- what protects hand curation from being wiped on every sync. But the
-- column has no DEFAULT, so a new row lands with category NULL -- invisible
-- to BOM auto-population and silently absent from the bottle calculator.
--
-- We saw exactly this: the first sync landed 1927 rows, every one NULL.
--
-- A scheduled "classify the new ones" script would work, but it is one more
-- thing to remember and one more thing that can silently stop running. A
-- trigger cannot be forgotten. It fires for the sync, for the admin UI, for
-- a manual INSERT in the SQL editor -- any path that creates a row.
--
-- THE GUARD THAT MATTERS: `if new.category is null`. The trigger only fills
-- a blank, never overwrites a value, so an admin correction survives every
-- future sync. Setting a category back to NULL by hand is therefore also
-- the way to say "reclassify this one for me".

-- ============================================================
-- 1. Classifier, shared by trigger and backfill
--
-- Same rule order as packaging_components_categorize.sql: the -PK-/-LL-/
-- -UC- infix is the primary signal, the description disambiguates within
-- it, and the specific tests (band, sleeve, liner) sit above the generic
-- ones (bottle, cap, box) because CASE returns on first match.
-- ============================================================
create or replace function public.packaging_component_category(
  p_name text,
  p_kind text
) returns text
language sql
immutable
as $fn$
  select case
    when p_kind = 'uc' and (p_name ilike '%ifc%' or p_name ilike '%insert%'
                            or p_name ilike '%leaflet%')       then 'insert'
    when p_kind = 'uc'                                         then 'carton'

    when p_kind = 'll' and p_name ilike '%band%'               then 'neckband'
    when p_kind = 'll' and p_name ilike '%sleeve%'             then 'sleeve'
    when p_kind = 'll'                                         then 'label'

    -- NKBND-<gauge> is neck-band stock with no English word in it, so it
    -- has to be named explicitly or it falls through to 'other'.
    when p_name ilike 'NKBND%' or p_name ilike '%neck band%'
         or p_name ilike '%neckband%' or p_name ilike '%band%' then 'neckband'
    when p_name ilike '%sleeve%'                               then 'sleeve'
    when p_name ilike '%bottle%' or p_name ilike '%jar%'       then 'bottle'
    -- CLOSURE MUST BE TESTED BEFORE LINER. Caps are routinely described by
    -- the liner they ship with -- "CAP / 33/400 WHT P/P R/S CAP W/ PRINTED
    -- PS-22 LINER" -- so a liner-first rule swallows them. It did: the first
    -- run put 20 rows in `liner`, all 20 mentioned "cap", and exactly 0 were
    -- genuine standalone liners. Reversing the order emptied the category
    -- with nothing lost. If a real liner-only part ever appears it still
    -- lands correctly, because it will not carry the word "cap".
    --
    -- Bracket expression, not a word-boundary escape: escapes get mangled
    -- passing through tooling, and a bare '%cap%' would match CAPSULE.
    when p_name ~* '(^|[^a-z])caps?([^a-z]|$)'
         or p_name ilike '%closure%' or p_name ilike '%lid%'   then 'closure'
    when p_name ilike '%liner%'                                then 'liner'
    when p_name ilike '%induction%' or p_name ilike '%tamper%'
         or p_name ilike '%safety seal%'                       then 'safety_seal'
    when p_name ilike '%master%' or p_name ilike '%shipper%'
         or p_name ilike '%box%' or p_name ilike '%carton%'    then 'master_box'
    when p_name ilike '%label%'                                then 'label'
    else 'other'
  end;
$fn$;

comment on function public.packaging_component_category(text, text) is
  'Classifies a packaging component into a BOM slot from its Fishbowl part-number infix and description. Immutable and side-effect free, so it can back a trigger, a backfill, or an ad-hoc query.';

-- ============================================================
-- 2. Trigger
-- ============================================================
create or replace function public.packaging_components_fill_category()
returns trigger
language plpgsql
as $fn$
begin
  -- Fill blanks only. Never clobber a curated value.
  if new.category is null and new.name is not null then
    new.category := public.packaging_component_category(new.name, new.kind);
  end if;
  return new;
end;
$fn$;

drop trigger if exists packaging_components_categorize on public.packaging_components;
create trigger packaging_components_categorize
  before insert or update on public.packaging_components
  for each row execute function public.packaging_components_fill_category();

-- ============================================================
-- 3. Backfill anything already sitting NULL
-- ============================================================
update public.packaging_components
set category = public.packaging_component_category(name, kind)
where category is null;

-- ============================================================
-- 4. Verify -- expect zero
-- ============================================================
-- select count(*) as uncategorized
-- from public.packaging_components where category is null;
--
-- Prove the trigger fires, without leaving test data behind:
--   begin;
--   insert into public.packaging_components (fp_code, name, kind, owner)
--   values ('PC-PK-TRIGGERTEST', 'BOTTLE / 500cc TEST PET', 'pk', 'pharmacenter');
--   select fp_code, category from public.packaging_components
--   where fp_code = 'PC-PK-TRIGGERTEST';   -- expect 'bottle'
--   rollback;
