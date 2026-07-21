-- Rollback for 20260721101100_create_body_measurements.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists body_measurement_values_update_own on public.body_measurement_values;
drop policy if exists body_measurement_values_insert_own on public.body_measurement_values;
drop policy if exists body_measurement_values_select_own on public.body_measurement_values;

drop trigger if exists trg_body_measurement_values_force_insert_audit_timestamps on public.body_measurement_values;
drop trigger if exists trg_body_measurement_values_set_updated_at on public.body_measurement_values;
drop trigger if exists trg_body_measurement_values_enforce_integrity on public.body_measurement_values;

drop function if exists public.enforce_body_measurement_values_integrity();

drop table if exists public.body_measurement_values cascade;

drop policy if exists body_measurements_update_own on public.body_measurements;
drop policy if exists body_measurements_insert_own on public.body_measurements;
drop policy if exists body_measurements_select_own on public.body_measurements;

drop trigger if exists trg_body_measurements_force_insert_audit_timestamps on public.body_measurements;
drop trigger if exists trg_body_measurements_set_updated_at on public.body_measurements;
drop trigger if exists trg_body_measurements_enforce_integrity on public.body_measurements;

drop function if exists public.enforce_body_measurements_integrity();

drop table if exists public.body_measurements cascade;

drop type if exists public.measurement_kind;
