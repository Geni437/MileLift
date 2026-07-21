# Rollback scripts

The Supabase CLI migration workflow (`supabase/migrations/`) is forward-only —
there is no native `down` migration mechanism; `supabase db reset` replays every
file in `supabase/migrations/` from scratch in order. Per `db-schema-standards`
("every migration has a working down/reversal") and `production-standards`,
each forward migration in this project is paired with a hand-written,
hand-tested reversal script here, named identically to the migration it undoes.

These scripts are **not** picked up or run automatically by the Supabase CLI.
To roll a migration back post-deploy:

```bash
# against local dev
supabase db execute -f supabase/migrations/rollbacks/<name>.sql

# against a remote/hosted project (requires appropriate credentials)
psql "$DATABASE_URL" -f supabase/migrations/rollbacks/<name>.sql
```

Roll back in the **reverse** order of the forward migrations (last-applied
first), because later migrations reference objects created by earlier ones
(e.g. `timeline_events` and `profile_health` both FK to `profiles`;
`profile_health`'s consent trigger reads `user_consents`).

Order to roll back, if rolling back everything (Phase 2 Module C first, since
it's layered on top of Phase 1's tables and the Phase 0 spine; the save/
PR-detection RPC layer next; those Phase 1 tables next; the Phase 0 spine last):
1. `20260721101500_create_strength_achievements.sql`
2. `20260721101400_create_strength_records.sql`
3. `20260721101300_create_progress_photos_storage_bucket.sql`
4. `20260721101200_create_progress_photos.sql` (does NOT remove the
   `body_image` consent_category enum value -- see that rollback's header)
5. `20260721101100_create_body_measurements.sql`
6. `20260721101000_create_bodyweight_logs.sql`
7. `20260721100900_create_workout_set_logs.sql`
8. `20260721100800_create_workout_sessions.sql`
9. `20260721100700_create_program_workouts.sql`
10. `20260721100600_create_programs.sql`
11. `20260721100500_create_workout_template_exercises.sql`
12. `20260721100400_create_workout_templates.sql`
13. `20260721100300_create_custom_exercises.sql`
14. `20260721100200_create_exercise_media_storage_bucket.sql`
15. `20260721100100_create_exercise_media.sql`
16. `20260721100000_create_exercises.sql`
17. `20260720100000_revert_pr_achievement_settle_check_unsound_batch_boundary.sql`
18. `20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql`
19. `20260719150000_add_activity_routes_simplified_path_geojson.sql`
20. `20260719140000_create_activity_save_and_pr_rpcs.sql`
21. `20260719133900_create_activity_tracks_storage_bucket.sql`
22. `20260719133800_create_kudos.sql`
23. `20260719133700_create_activity_achievements.sql`
24. `20260719133600_create_personal_records.sql`
25. `20260719133500_create_biometric_samples.sql`
26. `20260719133400_create_wearable_links.sql`
27. `20260719133300_create_activity_routes.sql`
28. `20260719133200_create_activity_details.sql`
29. `20260719133100_create_activity_types.sql`
30. `20260719133000_enable_postgis.sql`
31. `20260718210848_create_timeline_events.sql`
32. `20260718210837_create_profile_health.sql`
33. `20260718210826_create_user_consents.sql`
34. `20260718210814_create_profiles.sql`

Note: `20260720090000`'s own rollback restores the ORIGINAL (pre-fix)
immediate-logging behavior, which is also what `20260720100000` restores
going forward (`20260720100000` reverts `20260720090000`'s approach because
it was confirmed unsound, not because immediate per-transaction logging
itself was wrong — see `20260720100000`'s migration header). Rolling back
both `20260720100000` and `20260720090000` in sequence is safe and lands on
the same function bodies either way.

(The grant/privilege-lockdown correction migrations from 2026-07-19
[`20260719110557`..`20260719131119`] are additive ACL fixes with no table of
their own to drop — rolling back the tables above already removes what they
touched.)

Each script is written to be safe to re-run / run against a partially-applied
state (`IF EXISTS`, `CASCADE` where appropriate) rather than erroring out
partway through.

**These rollbacks drop data.** They are the mechanical reversal of a schema
change, not a data-preserving downgrade. If a migration has already taken
production writes, do not run its rollback without a separate data export/
backup plan — that is a deploy-time judgment call, not something a generic
`DROP TABLE` script can make safely on your behalf.
