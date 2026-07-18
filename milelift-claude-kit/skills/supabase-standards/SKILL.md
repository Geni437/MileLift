---
name: supabase-standards
description: Supabase-specific conventions for this project — Row Level Security as the primary authorization mechanism, Auth patterns, schema/migration workflow, Storage, and when to use PostgREST directly vs. an Edge Function vs. a Postgres function. Use for any schema, auth, storage, or Edge Function work.
when_to_use: Invoke for any database schema change, RLS policy, Auth flow, Storage bucket, or Edge Function work.
---

# Supabase Standards

MileLift's backend is Supabase: Postgres, Auth, Storage, and Edge Functions.
This changes the authorization model fundamentally from a typical hand-rolled
REST backend — read this before assuming `api-contract-standards`-style REST
conventions apply everywhere, because for anything Postgres exposes directly
through PostgREST, they don't.

## Row Level Security is the authorization mechanism, not a backstop

Every table containing user data has RLS enabled from the moment it's
created — never as a follow-up task. A policy-less table with RLS enabled is
inaccessible by default, which is the correct fail-closed state while a
table is mid-development; a table with RLS *disabled* "temporarily to get
it working" is the single most common way a Supabase project ships a real
data leak, because it's easy to forget to re-enable.

- Write policies against `auth.uid()`, never against a client-supplied user
  ID field — the client cannot be trusted to say who it is.
- Default posture per table: `SELECT`/`UPDATE`/`DELETE` scoped to
  `user_id = auth.uid()` (or the equivalent ownership check through a join,
  for tables that don't have a direct `user_id` column). Only widen this
  (community feed visibility, shared routines, leaderboards) with an
  explicit, reasoned policy — never default to permissive.
- For anything with a sharing/visibility dimension (activity feed, shared
  routines, community posts), the policy itself encodes the visibility rule
  — don't filter visibility in application code after an over-broad query;
  that's exactly the pattern that leaks data the moment a second code path
  queries the table and forgets the filter.
- Never store the service-role key on a mobile client or in any code path
  that ships to end users. It bypasses RLS entirely and is equivalent to
  root access to every user's data — it belongs only in Edge Function
  environment secrets and backend-only tooling.

## Profile table, not `auth.users` directly

Don't add application columns to Supabase's managed `auth.users` table.
Create a `public.profiles` table (or similarly named) with a `1:1` relation
to `auth.users.id`, populated via a trigger on user creation. This is where
CORE-18's "single unified profile" actually lives, and it's the row every
module's RLS policies ultimately trace ownership back to.

## PostgREST vs. Postgres function (RPC) vs. Edge Function

Three ways to expose logic; pick deliberately, not by default:

- **Direct PostgREST table/view access** (the auto-generated REST-ish API
  Supabase gives every table): the right choice for straightforward CRUD
  where RLS alone fully expresses the authorization rule — logging a set,
  reading your own activity history, updating your profile.
- **Postgres function (`SECURITY DEFINER` or `INVOKER`, called via RPC)**:
  the right choice when the operation needs transactional logic across
  multiple tables, or a computation that shouldn't live in application code
  (e.g. resolving current subscription entitlement, computing a streak).
  Prefer `SECURITY INVOKER` (runs as the calling user, RLS still applies)
  by default; only use `SECURITY DEFINER` when the operation genuinely needs
  to act with elevated privilege, and if so, validate authorization
  explicitly inside the function body since RLS won't do it for you there —
  a `SECURITY DEFINER` function is exactly as dangerous as the service-role
  key if it doesn't re-check who's calling it.
- **Edge Function** (Deno, `supabase/functions/`): the right choice for
  anything needing an external API call (LLM calls, payment provider
  webhooks, third-party wearable APIs), for logic too complex or too
  latency-sensitive for SQL, or for anything that needs its own independent
  deploy/rollback rather than shipping with a migration. This is where
  `ai-systems-engineer`'s work and payment webhook handling live.

## Schema & migration workflow

- All schema changes go through Supabase CLI migrations (`supabase
  migration new <name>`), checked into version control — never a manual
  change through the dashboard on anything past local development. A
  dashboard-only change is invisible to every other environment and to
  every other engineer.
- Every migration is tested against the local Supabase instance
  (`supabase db reset` replays all migrations from scratch) before it's
  considered done — a migration that only ever ran once, manually, against
  a hand-edited dev database is not verified.
- Historical-data-integrity and indexing rules from `db-schema-standards`
  still apply in full — Supabase doesn't change the underlying Postgres
  rules about snapshotting, typing, or indexing, only how access to that
  data is authorized.

## Storage

- Every bucket has RLS-equivalent policies on `storage.objects` — the same
  fail-closed default as table RLS. Progress photos and form-check videos
  are exactly the kind of content a misconfigured public bucket leaks.
- Serve user-uploaded content through signed URLs with short expiry, not
  permanently public bucket URLs, per `security-review`.

## Auth

- Supabase Auth issues short-lived JWTs with refresh tokens; the mobile
  client stores the session per `mobile-architecture-standards` (platform
  secure storage, never plain key-value storage).
- Social/OAuth sign-in (if used) and email/password should both funnel into
  the same `profiles` row creation trigger — one account per person
  regardless of sign-in method, per CORE-18.

## Versioning without URL versions

PostgREST doesn't version tables the way a hand-rolled REST API versions
URLs. Handle schema evolution instead by:

- Adding columns as nullable/defaulted first, backfilling, then tightening
  constraints in a later migration — never a breaking single-step change
  live clients depend on.
- Using a Postgres view as a stable public shape when the underlying table
  needs to change structurally — the view's shape stays constant for
  existing app versions while the base table evolves underneath it.
- Naming Postgres functions/RPCs with an explicit version suffix
  (`resolve_entitlement_v2`) when a function's contract changes
  incompatibly, rather than mutating the existing function's behavior out
  from under clients still calling it — this is the RPC equivalent of the
  `/v1` vs `/v2` path versioning in `api-contract-standards`, and the same
  backward-compatibility requirement applies: an old mobile app version in
  the field must keep working.

## Idempotency still applies

Sync writes from the mobile client (workout sets, activities) still need
client-generated idempotency keys, exactly as `api-contract-standards`
describes — RLS controls *who* can write, not whether a duplicate write
happens. Enforce idempotency with a unique constraint on the
client-generated ID plus an `ON CONFLICT DO NOTHING`/`DO UPDATE` upsert,
not application-level "check then insert" logic, which races under retry.
