-- v51.4: CFA batch size (kg) on the Scale up tab's Batch Setup card.
-- Defaults to 25 kg in the app when null.
alter table public.gummy_formula_versions
  add column if not exists cfa_batch_kg numeric;
