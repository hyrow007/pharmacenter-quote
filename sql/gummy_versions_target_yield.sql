-- v51.3: operator-settable Target Yield (finished gummies) on the
-- Scale up tab's Batch Setup card. Values routinely reach the hundreds
-- of thousands / millions, hence bigint. Null/0 = not set yet.
alter table public.gummy_formula_versions
  add column if not exists target_yield_units bigint;
