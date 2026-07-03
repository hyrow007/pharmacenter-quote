-- Add per-blend-phase process notes to gummy_formula_versions.
--
-- Each version stores a JSONB map keyed by blend phase — e.g.
--   { "pre-cook": "In a suitable container pre-blend pectin...",
--     "secondary": "...",
--     "final": "..." }
--
-- Kept as JSONB (rather than three text columns) so future blend phases
-- fit without another migration. NOT NULL with default '{}' lets old
-- versions read cleanly with no code branching.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.

alter table public.gummy_formula_versions
  add column if not exists process_notes jsonb not null default '{}'::jsonb;

comment on column public.gummy_formula_versions.process_notes is
  'Per-blend-phase process notes / mixing instructions. Keys are the blend phase (pre-cook, secondary, final); values are free text authored by R&D.';
