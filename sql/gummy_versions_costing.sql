-- v57.4: persist Costing-tab operator selections on the formula version.
--
-- Shape: { dec?: number, sources?: { [key]: string }, manualCosts?: { [key]: number } }
-- Keys are the costing table's dedup keys (rawMaterialId or "name:<lowercase>").
-- Default cost source ("Fish Bowl (Inventory)") entries are omitted by the app.

alter table public.gummy_formula_versions
  add column if not exists costing jsonb;

comment on column public.gummy_formula_versions.costing is
  'Costing tab selections: cost source per ingredient, manual $/kg entries, decimal precision.';
