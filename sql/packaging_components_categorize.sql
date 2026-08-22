-- Derive packaging_components.category from the Fishbowl description.
--
-- WHY: Fishbowl only tells us the part-number infix -PK-/-LL-/-UC-, which
-- lumps bottles, caps, liners and master boxes into one bucket. The BOM
-- cannot know which component fills which slot without a finer category,
-- and typing 1927 of them by hand is not a plan. The descriptions are
-- consistent enough to classify.
--
-- RE-RUNNABLE. The Fishbowl sync deliberately never writes `category`, so
-- existing curation survives a sync -- but NEW parts arrive with category
-- NULL. Use section 2 after a sync to catch only those; section 1
-- reclassifies everything from scratch and WILL overwrite hand corrections.
--
-- ORDER MATTERS. The CASE returns on first match, so the specific tests
-- (band, sleeve, liner) sit above the generic ones (bottle, cap, box).
-- Fishbowl files shrink bands under -LL- alongside real labels, so those
-- have to be pulled out before the -LL- catch-all fires.
--
-- Result on the 2026-08-20 sync (1927 rows, zero left NULL):
--   label 573 | other 490 | carton 297 | master_box 170 | bottle 162
--   closure 142 | neckband 39 | liner 20 | sleeve 16 | insert 13
--   safety_seal 5
--
-- NOTE ON `other` (490 rows, 273 PharmaCenter-owned): this is mostly
-- customer-name-prefixed stock where the component type never appears in
-- the string ("MASON / VITAMIN C 500mg", "Aroma Dead Sea LLC / ...") plus
-- genuinely non-bottle materials -- blister film (PVC/ACLAR), pouch stock,
-- silica desiccant. For a BOTTLE bill of materials `other` is the correct
-- home for most of it. Do not chase that number down for its own sake;
-- reclassify only the rows you actually need to quote.

-- ============================================================
-- 1. Full classification pass
-- ============================================================
update public.packaging_components set category = case

  -- -UC- : unit cartons, and the printed paper that goes inside them
  when kind = 'uc' and (name ilike '%ifc%' or name ilike '%insert%'
                        or name ilike '%leaflet%')          then 'insert'
  when kind = 'uc'                                          then 'carton'

  -- -LL- : labels -- but Fishbowl files bands and sleeves here too
  when kind = 'll' and name ilike '%band%'                  then 'neckband'
  when kind = 'll' and name ilike '%sleeve%'                then 'sleeve'
  when kind = 'll'                                          then 'label'

  -- -PK- : the mixed bucket. Most specific test wins.
  when name ilike '%band%'                                  then 'neckband'
  when name ilike '%sleeve%'                                then 'sleeve'
  when name ilike '%bottle%' or name ilike '%jar%'          then 'bottle'
  -- Bracket expression rather than a word-boundary escape: the escape gets
  -- mangled passing through tooling, and a bare '%cap%' would match
  -- CAPSULE. This matches "cap"/"caps" only when flanked by non-letters.
  when name ~* '(^|[^a-z])caps?([^a-z]|$)'
       or name ilike '%closure%' or name ilike '%lid%'      then 'closure'
  when name ilike '%liner%'                                 then 'liner'
  when name ilike '%induction%' or name ilike '%tamper%'
       or name ilike '%safety seal%'                        then 'safety_seal'
  when name ilike '%master%' or name ilike '%shipper%'
       or name ilike '%box%' or name ilike '%carton%'       then 'master_box'
  when name ilike '%label%'                                 then 'label'
  else 'other'
end;

-- Neck-band stock is coded NKBND-<gauge> with no English word in it, so the
-- description rules above cannot see it. Caught 18 rows on the first run.
update public.packaging_components set category = 'neckband'
where category = 'other'
  and (name ilike 'NKBND%' or name ilike '%neck band%'
       or name ilike '%neckband%' or name ilike '%shrink band%');

-- ============================================================
-- 2. Post-sync top-up -- classify ONLY new arrivals
--
-- Identical logic scoped to `category is null`, so it can never overwrite a
-- human correction made in the admin UI. This is the one to run on a
-- schedule; section 1 is a from-scratch rebuild.
-- ============================================================
update public.packaging_components set category = case
  when kind = 'uc' and (name ilike '%ifc%' or name ilike '%insert%'
                        or name ilike '%leaflet%')          then 'insert'
  when kind = 'uc'                                          then 'carton'
  when kind = 'll' and name ilike '%band%'                  then 'neckband'
  when kind = 'll' and name ilike '%sleeve%'                then 'sleeve'
  when kind = 'll'                                          then 'label'
  when name ilike 'NKBND%' or name ilike '%neck band%'
       or name ilike '%neckband%' or name ilike '%band%'    then 'neckband'
  when name ilike '%sleeve%'                                then 'sleeve'
  when name ilike '%bottle%' or name ilike '%jar%'          then 'bottle'
  when name ~* '(^|[^a-z])caps?([^a-z]|$)'
       or name ilike '%closure%' or name ilike '%lid%'      then 'closure'
  when name ilike '%liner%'                                 then 'liner'
  when name ilike '%induction%' or name ilike '%tamper%'
       or name ilike '%safety seal%'                        then 'safety_seal'
  when name ilike '%master%' or name ilike '%shipper%'
       or name ilike '%box%' or name ilike '%carton%'       then 'master_box'
  when name ilike '%label%'                                 then 'label'
  else 'other'
end
where category is null;

-- ============================================================
-- 3. Verify
-- ============================================================
-- select coalesce(category,'(NULL)') as category, count(*) as total,
--        count(*) filter (where owner='pharmacenter') as pc_owned
-- from public.packaging_components group by 1 order by 2 desc;
