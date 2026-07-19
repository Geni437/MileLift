-- Rollback for 20260719110603_add_profiles_training_balance.sql
-- Safe to re-run. DESTRUCTIVE: dropping the column discards any
-- training_balance_run_pct values already written by users. If this has
-- taken real writes, export the column first (e.g.
-- `select id, training_balance_run_pct from public.profiles where
-- training_balance_run_pct <> 50` to capture non-default values) before
-- running this rollback.

alter table public.profiles
  drop column if exists training_balance_run_pct;
-- The column-scoped grant (`grant update (training_balance_run_pct) ...`)
-- and the CHECK constraint are both dropped automatically as part of
-- dropping the column; no separate statements needed.
