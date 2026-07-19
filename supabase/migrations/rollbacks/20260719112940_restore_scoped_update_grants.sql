-- Rollback for 20260719112940_restore_scoped_update_grants.sql
-- Safe to re-run. Revokes exactly the column-scoped UPDATE grants this
-- migration added, returning to (unintentionally) zero UPDATE privilege for
-- authenticated on these tables -- i.e. this intentionally re-creates the
-- over-restrictive bug this migration fixed, so only use this if you are
-- deliberately re-doing the grant strategy from scratch in a follow-up
-- migration, not as a routine rollback.

revoke update (
  username, display_name, avatar_url,
  unit_weight, unit_distance, default_timezone,
  deletion_requested_at, training_balance_run_pct
) on public.profiles from authenticated;

revoke update (revoked_at) on public.user_consents from authenticated;

revoke update (sex, date_of_birth, height_cm) on public.profile_health from authenticated;

revoke update (
  event_type, occurred_at, local_date, event_timezone,
  energy_kcal, load_score, duration_seconds,
  confidence, needs_confirmation, visibility,
  deleted_at
) on public.timeline_events from authenticated;
