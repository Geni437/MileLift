-- Rollback for 20260719110557_add_profiles_username_unique_index.sql
-- Safe to re-run; no data loss (dropping a uniqueness index does not touch
-- the underlying column values).

drop index if exists public.uq_profiles_username_lower;
