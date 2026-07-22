-- Rollback for 20260722999998_diagnose_custom_foods_upsert_grant_gap.sql
--
-- Re-running this alone would re-introduce the accidental UPDATE(id) grant
-- this migration originally issued. In practice this rollback should never
-- be run on its own -- 20260722999999 already revokes that grant going
-- forward, so the live/intended state has UPDATE(id) absent regardless.
-- Provided only for convention-consistency (every forward migration has a
-- paired rollback file).

revoke update (id) on public.custom_foods from authenticated;
