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

Order to roll back, if rolling back everything:
1. `20260718210848_create_timeline_events.sql`
2. `20260718210837_create_profile_health.sql`
3. `20260718210826_create_user_consents.sql`
4. `20260718210814_create_profiles.sql`

Each script is written to be safe to re-run / run against a partially-applied
state (`IF EXISTS`, `CASCADE` where appropriate) rather than erroring out
partway through.

**These rollbacks drop data.** They are the mechanical reversal of a schema
change, not a data-preserving downgrade. If a migration has already taken
production writes, do not run its rollback without a separate data export/
backup plan — that is a deploy-time judgment call, not something a generic
`DROP TABLE` script can make safely on your behalf.
