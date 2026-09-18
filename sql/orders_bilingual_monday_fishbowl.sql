-- orders_bilingual_monday_fishbowl.sql
--
-- Adds Spanish companion columns for the two remaining English-only
-- data streams on the /orders landing page:
--   • Monday.com update bodies  (so_monday_activity.updates -> updates_es)
--   • Fishbowl SO memo field    (fishbowl_sales_orders.note   -> note_es)
--
-- These are populated by the translate-meeting-content-es scheduled
-- task (extended to cover these two feeds). The page reads *_es when
-- lang=es and falls back to the English canonical when null.
--
-- updates_es is a JSONB array in the SAME shape as updates, but with
-- text_body translated. Other fields (id, created_at, creator_name)
-- are echoed unchanged so the two arrays line up 1:1 by index.

alter table public.so_monday_activity
  add column if not exists updates_es jsonb;

alter table public.fishbowl_sales_orders
  add column if not exists note_es text;

-- No index needed — both columns are lookup-by-primary-key reads.
