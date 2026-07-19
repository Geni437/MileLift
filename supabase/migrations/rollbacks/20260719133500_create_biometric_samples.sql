-- Rollback for 20260719133500_create_biometric_samples.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists biometric_samples_update_own on public.biometric_samples;
drop policy if exists biometric_samples_insert_own on public.biometric_samples;
drop policy if exists biometric_samples_select_own on public.biometric_samples;

drop trigger if exists trg_biometric_samples_force_insert_audit_timestamps on public.biometric_samples;
drop trigger if exists trg_biometric_samples_set_updated_at on public.biometric_samples;
drop trigger if exists trg_biometric_samples_enforce_integrity on public.biometric_samples;

drop function if exists public.enforce_biometric_samples_integrity();

drop table if exists public.biometric_samples cascade;

drop type if exists public.biometric_sample_kind;
