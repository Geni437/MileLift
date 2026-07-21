-- Rollback for 20260720200000_reissue_profiles_update_grant.sql
revoke update (
  username, display_name, avatar_url,
  unit_weight, unit_distance, default_timezone,
  deletion_requested_at, training_balance_run_pct
) on public.profiles from authenticated;
