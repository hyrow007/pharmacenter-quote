-- Add label claims to gummy_formula_versions.
--
-- Label claims are the active-ingredient amounts printed on the finished
-- product's label (e.g. "Vitamin D3 25 mcg"). They're per-version because
-- when the recipe changes the claims frequently move too.
--
-- Shape (JSONB array): [{ id, rawMaterialId, rawMaterialFpCode, amount, unit }]
-- unit is one of 'mcg' | 'mg' | 'g'; UI defaults new rows to 'mg'.

alter table public.gummy_formula_versions
  add column if not exists label_claims jsonb not null default '[]'::jsonb;

comment on column public.gummy_formula_versions.label_claims is
  'Label claims for active ingredients (what shows on the finished-product label). Array of {id, rawMaterialId, rawMaterialFpCode, amount, unit} — unit is mcg/mg/g, UI defaults to mg.';
