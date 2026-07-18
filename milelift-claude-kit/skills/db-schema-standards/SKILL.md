---
name: db-schema-standards
description: Schema design and migration conventions for this app — key strategy, historical data integrity, indexing, and safe migrations. Use when designing tables, writing migrations, or reviewing schema changes.
when_to_use: Invoke when creating or modifying database schema, writing migrations, or reviewing query performance.
---

# Database Schema Standards

## Keys

- Primary keys are UUIDs (or ULIDs if you want sortability) generated
  client-side where records can originate offline on a mobile device
  (workout logs, sets). A client-generated ID means a record created offline
  and synced later doesn't need the server round-trip to exist, and it's the
  natural idempotency key for sync writes (see `api-contract-standards`).
  Auto-increment integers are fine for server-originated, never-offline
  resources (e.g. an internal admin table).

## Historical data integrity — the fitness-app-specific rule

- **Snapshot, don't reference, at the point of logging.** When a user logs a
  set against an exercise, store the exercise name/unit at that point in a
  denormalized snapshot on the log row, in addition to the foreign key to
  the current exercise definition. If the exercise library entry is later
  edited (renamed, unit changed) the user's historical log must not silently
  change retroactively — that's a real, reported bug pattern in fitness
  apps and it erodes trust in the training log fast.
- Similarly, if body-weight-relative calculations are stored (e.g. weight as
  % of bodyweight), store the bodyweight-at-time-of-log alongside, not just
  a live join to "current" bodyweight.

## Types

- Weight, distance, and other measured quantities: `numeric`/`decimal`, never
  `float`/`double` — floating point rounding errors compound over a large
  workout history and will eventually produce visibly wrong totals.
- Store the unit explicitly per record (or per user-profile default that's
  copied onto the record at write time) rather than assuming a global unit —
  users switch between kg/lb and the app must know which was used for each
  historical entry.
- Timestamps: `timestamptz` (UTC), never a naive timestamp with an implicit
  timezone assumption.

## Indexing

- Composite index on `(user_id, performed_at)` (or equivalent) on any
  time-series table (workout logs, body measurements) — the dominant query
  pattern is "this user's records in a date range," and a single-column
  index on `user_id` alone forces a sort on every query at scale.
- Index foreign keys used in joins; don't rely on the primary key index of
  the referenced table covering the join direction you actually query.
- Review any new index against write volume — a heavily-written table (set
  logs, during an active workout) with too many indexes slows every insert;
  justify each one.

## Deletion & soft-delete

- Decide per-table whether deletion is hard or soft, and be consistent. Health
  data the user has a right to delete (see `health-data-compliance`) needs an
  actual hard-delete path eventually, even if there's a soft-delete grace
  period first — a `deleted_at` flag that's checked everywhere but the data
  never actually purged does not satisfy a deletion request.
- If soft-deleting, every query against that table must filter
  `deleted_at IS NULL` — enforce this at the query-layer/ORM default scope,
  not by remembering to add the clause in every hand-written query.

## Migrations

- Every migration has a working `down`/reversal, even if "reversal" means
  "safely no-ops on already-migrated data" — untested one-way migrations are
  a production incident waiting to happen.
- No blocking schema changes on large tables in a single migration without
  considering lock duration (e.g. adding a `NOT NULL` column with a default
  on a large table can lock writes on some databases — batch/backfill
  separately from the constraint addition where the database requires it).
- Constraints (foreign keys, `NOT NULL`, `CHECK`) enforced at the database
  level, not only in application code — application-level checks get
  bypassed by direct DB access, admin scripts, or a bug in a different code
  path.
