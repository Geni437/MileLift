-- =============================================================================
-- Phase 2 — Module C: workout_sessions (CORE-12 subtype, 1:1 with the spine)
-- Design ref: docs/architecture/phase-2-module-c.md §1.4, §1.6, §8, §8.1
--
-- Shared PK = timeline_event_id, 1:1 FK to timeline_events.id, inserted in
-- the same transaction as its spine row via the (backend-builder-owned)
-- save_workout_session_v1 RPC. Covers event_type = 'strength_session'.
-- Session-level metadata only -- the sets are the child collection
-- (workout_set_logs, next migration).
--
-- Doc-inconsistency note (flagged prominently in the task report): §8's main
-- RLS-boundary table states workout_sessions is soft-deleted "on the parent
-- spine row + cascade at hard-purge, mirroring activity_details" -- and
-- activity_details (the named precedent) has NO deleted_at column of its own
-- (verified by reading 20260719133200_create_activity_details.sql). But
-- §8.1's column-scoped-grant list for workout_sessions includes `deleted_at`
-- in the mutable set. These two statements conflict. This migration follows
-- the more specific, explicit RLS-boundary statement + the named precedent:
-- NO deleted_at column here: soft-delete of a whole session is done via
-- timeline_events.deleted_at (already covered by that table's own
-- column-scoped UPDATE grant), the general Phase 0 mechanism used everywhere
-- else in the app. §8.1's mention of `deleted_at` for this table is treated
-- as a drafting artifact (most likely bled over from the very next bullet,
-- workout_set_logs, which correctly does have its own per-set deleted_at).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100800_create_workout_sessions.sql
-- =============================================================================

create table public.workout_sessions (
  timeline_event_id     uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS per §1.4/§8; consistency with the spine's own
  -- user_id enforced by the trigger below.
  user_id               uuid not null references public.profiles (id) on delete cascade,

  title                 text,
  notes                 text,

  -- Nullable + SET NULL: deleting a template never deletes history (§1.4).
  source_template_id    uuid references public.workout_templates (id) on delete set null,
  -- Snapshot at log time (§3) -- editing/deleting the template never
  -- rewrites this session's rendered history.
  template_name_snapshot text,

  session_rpe           numeric
    constraint workout_sessions_session_rpe_range_chk check (session_rpe is null or (session_rpe >= 0 and session_rpe <= 10)),

  -- Snapshots recomputed by the save RPC on every edit, never live-joined
  -- (§1.4) -- so history/analytics reads never re-scan every set.
  total_volume_kg        numeric
    constraint workout_sessions_total_volume_non_negative_chk check (total_volume_kg is null or total_volume_kg >= 0),
  total_sets             integer
    constraint workout_sessions_total_sets_non_negative_chk check (total_sets is null or total_sets >= 0),

  -- Reused enum (§11 tradeoff: "shared enum for the shared spine concept,
  -- rather than a near-identical parallel enum").
  calories_source        public.activity_calories_source not null default 'none',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.workout_sessions is
  'CORE-12 strength-session subtype, 1:1 with timeline_events (shared PK, '
  'event_type = strength_session). Session-level metadata only -- sets are '
  'the workout_set_logs child collection. A strength_session CAN be shared '
  '(§1.4) -- it is not in the spine''s never-shareable list, unlike this '
  'module''s biometric event types.';
comment on column public.workout_sessions.total_volume_kg is
  'Snapshot at save: sum(reps * weight_kg) over working sets. Denormalized '
  'so history/analytics reads don''t re-scan every set (§1.4, §4.4).';

-- FK used in joins ("sessions logged from this template" -- e.g. before
-- warning on template deletion, or a "used in N sessions" builder stat),
-- per db-schema-standards. Partial: most sessions are NOT logged from a
-- template (freeform logging is the common case), so the sparse partial
-- index stays small.
create index idx_workout_sessions_source_template
  on public.workout_sessions (source_template_id)
  where source_template_id is not null;

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (§1.6): (1) user_id must match the spine row's
-- user_id, mirroring enforce_activity_details_integrity; (3) the referenced
-- spine row's event_type must be 'strength_session'. (§1.6 item 2,
-- "exactly one of exercise_id/custom_exercise_id", applies to
-- workout_set_logs, not this table -- see that migration.)
-- -----------------------------------------------------------------------------
create or replace function public.enforce_workout_sessions_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id    uuid;
  v_spine_event_type public.timeline_event_type;
begin
  select user_id, event_type
    into v_spine_user_id, v_spine_event_type
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'workout_sessions write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'workout_sessions.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'strength_session' then
    raise exception
      'workout_sessions write rejected: timeline_events.event_type (%) for event % is not strength_session',
      v_spine_event_type, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_workout_sessions_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) the spine '
  'event''s event_type must be strength_session. §1.6.';

revoke execute on function public.enforce_workout_sessions_integrity() from public, anon, authenticated;

create trigger trg_workout_sessions_enforce_integrity
  before insert or update on public.workout_sessions
  for each row
  execute function public.enforce_workout_sessions_integrity();

create trigger trg_workout_sessions_set_updated_at
  before update on public.workout_sessions
  for each row
  execute function public.set_updated_at();

create trigger trg_workout_sessions_force_insert_audit_timestamps
  before insert on public.workout_sessions
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id; SELECT/INSERT/UPDATE, no
-- client DELETE (soft-delete on the parent spine row + cascade at
-- hard-purge, mirroring activity_details -- see migration header note above).
-- -----------------------------------------------------------------------------
alter table public.workout_sessions enable row level security;

create policy workout_sessions_select_own
  on public.workout_sessions
  for select
  to authenticated
  using (user_id = auth.uid());

create policy workout_sessions_insert_own
  on public.workout_sessions
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy workout_sessions_update_own
  on public.workout_sessions
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.workout_sessions to authenticated;
-- Column-scoped UPDATE excluding timeline_event_id/user_id/created_at
-- (immutable identity columns) per §8.1. See migration header for why
-- deleted_at is deliberately NOT in this list (no such column exists here).
grant update (
  title, notes, source_template_id, template_name_snapshot,
  session_rpe, total_volume_kg, total_sets, calories_source
) on public.workout_sessions to authenticated;
