-- =============================================================================
-- Phase 2 — Module C: workout_set_logs (the set/rep/weight firehose, CORE-12)
-- Design ref: docs/architecture/phase-2-module-c.md §1.5, §1.6, §3, §8, §8.1, §9.2
--
-- The heart of CORE-12 and the offline-idempotency design (§9). One row per
-- set, each carrying its own client-generated id (a second idempotency grain
-- below the session, §9.2). Hangs off workout_sessions, not the spine (Phase
-- 0 §1.5: deeper child collections hang off the detail table). The most
-- heavily-written table in the module -- every index below is justified
-- against insert cost, per db-schema-standards.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100900_create_workout_set_logs.sql
-- =============================================================================

create type public.workout_set_type as enum ('working', 'warmup', 'dropset', 'failure', 'amrap');

comment on type public.workout_set_type is
  'Warmups excluded from volume/PR by default (§1.5, §4). Add-only enum.';

create table public.workout_set_logs (
  -- Client-generated on-device -- the per-set idempotency key (§9.2).
  id                       uuid primary key default gen_random_uuid(),

  timeline_event_id        uuid not null references public.workout_sessions (timeline_event_id) on delete cascade,
  -- Denormalized for RLS; consistency with the parent session's user_id
  -- enforced by the trigger below.
  user_id                  uuid not null references public.profiles (id) on delete cascade,

  exercise_id              uuid references public.exercises (id),
  custom_exercise_id       uuid references public.custom_exercises (id),
  -- Snapshot at log time (§3, the gate rule) -- editing/renaming/deleting the
  -- referenced library or custom exercise never rewrites this row's history.
  exercise_name_snapshot   text not null
    constraint workout_set_logs_exercise_name_snapshot_not_blank_chk check (length(trim(exercise_name_snapshot)) > 0),
  primary_muscle_snapshot  public.muscle_group,

  exercise_order           integer not null
    constraint workout_set_logs_exercise_order_non_negative_chk check (exercise_order >= 0),
  set_number               integer not null
    constraint workout_set_logs_set_number_positive_chk check (set_number >= 1),
  set_type                 public.workout_set_type not null default 'working',

  reps                     integer
    constraint workout_set_logs_reps_non_negative_chk check (reps is null or reps >= 0),
  weight_kg                numeric
    constraint workout_set_logs_weight_non_negative_chk check (weight_kg is null or weight_kg >= 0),
  unit_weight_snapshot     text not null
    constraint workout_set_logs_unit_weight_snapshot_chk check (unit_weight_snapshot in ('kg', 'lb')),
  is_bodyweight            boolean not null default false,

  duration_seconds         integer
    constraint workout_set_logs_duration_non_negative_chk check (duration_seconds is null or duration_seconds >= 0),
  distance_m               numeric
    constraint workout_set_logs_distance_non_negative_chk check (distance_m is null or distance_m >= 0),

  rpe                      numeric
    constraint workout_set_logs_rpe_range_chk check (rpe is null or (rpe >= 0 and rpe <= 10)),

  rest_seconds_planned     integer
    constraint workout_set_logs_rest_planned_non_negative_chk check (rest_seconds_planned is null or rest_seconds_planned >= 0),
  rest_seconds_actual      integer
    constraint workout_set_logs_rest_actual_non_negative_chk check (rest_seconds_actual is null or rest_seconds_actual >= 0),

  is_completed             boolean not null default true,

  -- Snapshot (§4.2) -- Epley at save time, never live-recomputed. History is
  -- stable if the formula changes; PR detection reads this column directly.
  estimated_1rm_kg         numeric
    constraint workout_set_logs_estimated_1rm_non_negative_chk check (estimated_1rm_kg is null or estimated_1rm_kg >= 0),

  notes                    text,

  -- Soft-delete: a removed set syncs as an explicit deleted_at, never an
  -- omission (§9.2) -- a truncated/retried sync payload can never destroy sets.
  deleted_at                timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- §1.6 item 2: exactly one of exercise_id/custom_exercise_id. Implemented
  -- as a table CHECK (needs no other-table lookup) rather than inside the
  -- seam-integrity trigger below -- cheaper on this module's hottest write
  -- path (db-engineer judgment call, flagged in the task report).
  constraint workout_set_logs_exactly_one_exercise_ref_chk check (
    (exercise_id is not null)::int + (custom_exercise_id is not null)::int = 1
  )
);

comment on table public.workout_set_logs is
  'CORE-12 set/rep/weight firehose (§1.5). One row per set, client-generated '
  'id doubling as the per-set sync idempotency key (§9.2). Snapshots the '
  'exercise name/muscle at log time (§3) -- the gate rule: editing the '
  'library never retroactively rewrites a logged set.';
comment on column public.workout_set_logs.estimated_1rm_kg is
  'Epley formula snapshot at save time: weight_kg * (1 + reps/30) (§4.2, §12 '
  'item 3). Stored, not live-computed, so history is stable across formula '
  'changes and PR detection is a plain column read.';
comment on column public.workout_set_logs.deleted_at is
  'Soft-delete tombstone, set explicitly by the client on set removal -- '
  'never inferred from omission in a synced payload (§9.2).';

-- Indexes (§1.5's explicit list, db-schema-standards: justified against
-- write cost on this module's hottest write path).

-- "Load this session's sets in order" -- the dominant read + session render.
create index idx_workout_set_logs_session_order
  on public.workout_set_logs (timeline_event_id, exercise_order, set_number);

-- "All my sets of this library movement over time" (analytics/PR reads,
-- §4.3/§4.4) -- partial on both deleted_at and exercise_id being present so
-- the index only carries rows it actually serves.
create index idx_workout_set_logs_user_exercise
  on public.workout_set_logs (user_id, exercise_id)
  where deleted_at is null and exercise_id is not null;

-- Parallel partial index for custom movements (§1.5).
create index idx_workout_set_logs_user_custom_exercise
  on public.workout_set_logs (user_id, custom_exercise_id)
  where deleted_at is null and custom_exercise_id is not null;

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (§1.6 item 1): user_id must match the parent
-- workout_sessions row's user_id, mirroring enforce_activity_routes_integrity.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_workout_set_logs_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session_user_id uuid;
begin
  select user_id into v_session_user_id
    from public.workout_sessions
    where timeline_event_id = new.timeline_event_id;

  if v_session_user_id is null then
    raise exception
      'workout_set_logs write rejected: no workout_sessions row found for timeline_event_id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_session_user_id <> new.user_id then
    raise exception
      'workout_set_logs.user_id (%) does not match workout_sessions.user_id (%) for session %',
      new.user_id, v_session_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_workout_set_logs_integrity() is
  'Trigger: user_id must match the parent workout_sessions row''s user_id. '
  'The event_type=strength_session invariant is enforced transitively via '
  'that session''s own trigger at its insert time -- not re-checked per-set, '
  'to avoid an extra join on this table''s hottest write path (§1.6).';

revoke execute on function public.enforce_workout_set_logs_integrity() from public, anon, authenticated;

create trigger trg_workout_set_logs_enforce_integrity
  before insert or update on public.workout_set_logs
  for each row
  execute function public.enforce_workout_set_logs_integrity();

create trigger trg_workout_set_logs_set_updated_at
  before update on public.workout_set_logs
  for each row
  execute function public.set_updated_at();

create trigger trg_workout_set_logs_force_insert_audit_timestamps
  before insert on public.workout_set_logs
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id; SELECT/INSERT/UPDATE, no
-- client DELETE (soft-delete via deleted_at, §9.2).
-- -----------------------------------------------------------------------------
alter table public.workout_set_logs enable row level security;

create policy workout_set_logs_select_own
  on public.workout_set_logs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy workout_set_logs_insert_own
  on public.workout_set_logs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy workout_set_logs_update_own
  on public.workout_set_logs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.workout_set_logs to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1, live-confirmed naive-.upsert() gotcha --
-- see 20260719112940_restore_scoped_update_grants.sql for the mechanism this
-- guards against). Mutable/immutable split copied verbatim from §8.1:
--
--   Mutable (granted below): exercise_order, set_number, set_type, reps,
--   weight_kg, unit_weight_snapshot, is_bodyweight, duration_seconds,
--   distance_m, rpe, rest_seconds_planned, rest_seconds_actual, is_completed,
--   estimated_1rm_kg, notes, deleted_at.
--   Immutable (excluded): id, timeline_event_id, user_id, exercise_id,
--   custom_exercise_id, exercise_name_snapshot, primary_muscle_snapshot,
--   created_at.
--
-- The write path SHOULD be save_workout_session_v1 (backend-builder), which
-- performs INSERT ... ON CONFLICT (id) DO UPDATE across every column
-- server-side (running as the owning function's SECURITY INVOKER context, so
-- it is still subject to this same grant -- its ON CONFLICT SET list must
-- also stay within the mutable columns below, or its own upsert will fail to
-- plan for the identical reason a naive client .upsert() would). A direct
-- table upsert (e.g. toggling one set's is_completed) MUST target only the
-- mutable column list with an explicit column list, not a whole-row object.
-- -----------------------------------------------------------------------------
grant update (
  exercise_order, set_number, set_type, reps, weight_kg, unit_weight_snapshot,
  is_bodyweight, duration_seconds, distance_m, rpe, rest_seconds_planned,
  rest_seconds_actual, is_completed, estimated_1rm_kg, notes, deleted_at
) on public.workout_set_logs to authenticated;
