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

Order to roll back, if rolling back everything (the save/PR-detection RPC
layer first, since it's built on top of the Phase 1 Module A tables; those
tables first, since they're layered on top of the Phase 0 spine):
1. `20260719140000_create_activity_save_and_pr_rpcs.sql`
2. `20260719133900_create_activity_tracks_storage_bucket.sql`
3. `20260719133800_create_kudos.sql`
4. `20260719133700_create_activity_achievements.sql`
5. `20260719133600_create_personal_records.sql`
6. `20260719133500_create_biometric_samples.sql`
7. `20260719133400_create_wearable_links.sql`
8. `20260719133300_create_activity_routes.sql`
9. `20260719133200_create_activity_details.sql`
10. `20260719133100_create_activity_types.sql`
11. `20260719133000_enable_postgis.sql`
12. `20260718210848_create_timeline_events.sql`
13. `20260718210837_create_profile_health.sql`
14. `20260718210826_create_user_consents.sql`
15. `20260718210814_create_profiles.sql`

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
