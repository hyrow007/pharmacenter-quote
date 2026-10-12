-- v85.9 — free-text customer on a formula.
--
-- Why here and not in `customers`: that table is upserted by the nightly
-- Fishbowl sync keyed on Fishbowl's own id (`external_id = 'fb:<id>'`), and
-- it leaves rows with source <> 'fishbowl' alone. A hand-made customer row
-- would therefore survive the sync but could never match the real company
-- when Fishbowl finally gets it — two rows, same name, every formula still
-- pointed at the orphan. Keeping the typed name on the formula keeps the
-- shared table clean and makes "promotion" a one-click act: pick the real
-- customer and the text is dropped.
--
-- Mutually exclusive with customer_id by construction in the API routes
-- (PUT/POST /api/formulas): setting either one nulls the other.

alter table public.gummy_formulas
  add column if not exists customer_name_manual text;

comment on column public.gummy_formulas.customer_name_manual is
  'Free-text customer for a company not yet in Fishbowl. Null whenever customer_id is set.';
