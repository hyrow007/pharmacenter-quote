-- Relax the piece-weight CHECK constraints so a newly created formula
-- can start with 0 g placeholders (task #298 changed the UI defaults
-- from 3.0 / 3.5 to 0). Formula creation was failing on:
--
--   new row for relation "gummy_formula_versions" violates check
--   constraint "gummy_formula_versions_gummy_piece_weight_g_check"
--
-- The original constraint (from gummy_formulas.sql) enforced > 0. We
-- want >= 0 so the initial insert works; the rep sets the real weight
-- in the Batch Setup card afterwards.
--
-- Run this once in the Supabase SQL Editor.

alter table gummy_formula_versions
  drop constraint if exists gummy_formula_versions_gummy_piece_weight_g_check;

alter table gummy_formula_versions
  add constraint gummy_formula_versions_gummy_piece_weight_g_check
  check (gummy_piece_weight_g >= 0);

-- Same relaxation for wet_cast_piece_weight_g if a similar CHECK
-- exists from the wet_cast migration.
alter table gummy_formula_versions
  drop constraint if exists gummy_formula_versions_wet_cast_piece_weight_g_check;

alter table gummy_formula_versions
  add constraint gummy_formula_versions_wet_cast_piece_weight_g_check
  check (wet_cast_piece_weight_g is null or wet_cast_piece_weight_g >= 0);
