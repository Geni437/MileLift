-- =============================================================================
-- Phase 2 — Module C: exercises (the global exercise library, CORE-13)
-- Design ref: docs/architecture/phase-2-module-c.md §1.1, §2, §8, §12 item 1/2
--
-- NOT user-owned, NOT a timeline event — same ownership class as
-- activity_types / the food DB (Phase 0 §5/§8, Phase 1's
-- 20260719133100_create_activity_types.sql): global, read-mostly,
-- service-role-write, public-read to authenticated. Modeled as a table (not
-- an enum) because PR eligibility, muscle targeting, equipment filtering, and
-- search all need per-movement metadata (§1.1).
--
-- Seeded/maintained by an ingestion job (backend-builder, §2.1), not
-- hand-edited — extending the library later is a plain INSERT, not a schema
-- change. This migration ships a small ILLUSTRATIVE starter seed (a dozen
-- common movements) so RLS/grants/library-read behavior can be verified
-- end-to-end without waiting on the real Free-Exercise-DB + wger ingestion
-- pipeline (§2.1, §12 item 2: "the gate does NOT require literally hitting
-- 1,400+"). This is explicitly NOT the merged-source ingestion — db-engineer's
-- proposed seed *strategy* (for backend-builder to implement as the real
-- ingestion job) is documented in the task report, not executed here.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100000_create_exercises.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (§1.1). Add-only per supabase-standards — extend with
-- `alter type ... add value 'x';` in a later migration, never remove/rename.
--
-- muscle_group's exact value list is not given verbatim in the architecture
-- doc (only examples: quadriceps, chest, lats) — db-engineer judgment call:
-- a standard anatomical taxonomy sized for UNQ-09 muscle-categorized
-- browsing/analytics without being so granular it's unusable as a filter UI.
-- Flagged in the task report for confirmation.
-- -----------------------------------------------------------------------------
create type public.muscle_group as enum (
  'chest', 'back', 'lats', 'traps', 'shoulders', 'biceps', 'triceps', 'forearms',
  'abs', 'obliques', 'quadriceps', 'hamstrings', 'glutes', 'calves',
  'adductors', 'abductors', 'neck', 'full_body', 'cardio'
);

comment on type public.muscle_group is
  'Muscle taxonomy for exercise/custom_exercise categorization + muscle-volume '
  'analytics (§1.1, §4.4). Value list is a db-engineer proposal (not verbatim '
  'from the architecture doc) — flagged for confirmation. Add-only enum.';

-- Exact value list per §1.1.
create type public.equipment_type as enum (
  'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other'
);

comment on type public.equipment_type is
  'Drives the builder''s equipment filter + AI-generated-workout equipment '
  'matching (§1.1). Add-only enum.';

-- Exact value list per §1.1.
create type public.exercise_mechanic as enum ('compound', 'isolation');

comment on type public.exercise_mechanic is
  'For analytics + program balance (§1.1). Nullable on exercises/custom_exercises. Add-only enum.';

-- Exact value list per §1.1.
create type public.exercise_force_vector as enum ('push', 'pull', 'static');

comment on type public.exercise_force_vector is
  'For analytics + program balance (§1.1). Nullable. Add-only enum.';

-- Exact value list per §1.1/§2.
create type public.source_dataset as enum ('free_exercise_db', 'wger', 'milelift_authored');

comment on type public.source_dataset is
  'Provenance for attribution/licensing (§1.1, §2). Free Exercise DB '
  '(public-domain, Unlicense) + wger (CC-BY-SA 4.0, attribution + '
  'share-alike obligations) + milelift_authored (owned outright). Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.exercises
-- -----------------------------------------------------------------------------
create table public.exercises (
  id                  uuid primary key default gen_random_uuid(),

  slug                text not null unique
    constraint exercises_slug_not_blank_chk check (length(trim(slug)) > 0),
  name                text not null
    constraint exercises_name_not_blank_chk check (length(trim(name)) > 0),

  primary_muscle      public.muscle_group not null,
  secondary_muscles   public.muscle_group[] not null default '{}',

  equipment           public.equipment_type not null,
  mechanic            public.exercise_mechanic,
  force_vector        public.exercise_force_vector,

  -- Which of {reps, weight, distance, duration} a set of this movement
  -- records (§1.1) — drives the logging UI's field set and which PR metrics
  -- apply (§4.1). At least one must be true: every library movement must
  -- record *something* loggable (db-engineer invariant, not verbatim from
  -- the doc — flagged in the task report).
  is_distance_based  boolean not null default false,
  is_time_based      boolean not null default false,
  is_weighted        boolean not null default false,
  is_bodyweight      boolean not null default false,

  instructions        text,

  source               public.source_dataset not null,
  attribution          text,

  is_active            boolean not null default true,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint exercises_field_set_chk check (
    is_distance_based or is_time_based or is_weighted or is_bodyweight
  )
);

comment on table public.exercises is
  'CORE-13 global exercise library (§1.1). Not user-owned, not a timeline '
  'event. Service-role-write (ingestion job), public-read to authenticated. '
  'workout_set_logs/workout_template_exercises snapshot the name/muscle at '
  'reference time so editing this catalog never rewrites history (§3).';
comment on column public.exercises.is_active is
  'Soft-hide a bad/duplicate entry without deleting (§1.1) — history still '
  'resolves via FK, and snapshot columns on set logs are unaffected either way.';
comment on column public.exercises.attribution is
  'Per-entry attribution string the source license requires be shown in-app '
  '(§2, §6) — must actually render on a library/credits surface, not just live '
  'in this column.';

create trigger trg_exercises_set_updated_at
  before update on public.exercises
  for each row
  execute function public.set_updated_at();

create trigger trg_exercises_force_insert_audit_timestamps
  before insert on public.exercises
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- Indexes (db-schema-standards: tied to a named query pattern, not
-- speculative). Read-mostly, ~1,400-row target table — modest index set.
-- -----------------------------------------------------------------------------

-- "Browse/filter the library by muscle group" (UNQ-09) — active entries only,
-- since a hidden/superseded entry shouldn't appear in a fresh browse.
create index idx_exercises_active_primary_muscle
  on public.exercises (primary_muscle)
  where is_active;

-- "Filter the library/builder by available equipment" (§1.1).
create index idx_exercises_active_equipment
  on public.exercises (equipment)
  where is_active;

-- Note: no name-search index (trigram/full-text) added here — at the
-- ~1,400-row target size a sequential scan is cheap, and the actual search
-- RPC's query shape is backend-builder's call (§5: "a filtered select or a
-- search RPC"). Adding a speculative GIN/trigram index ahead of that
-- concrete shape would violate db-schema-standards' "tied to an actual query
-- pattern" rule — left for a follow-up migration once the search RPC exists.

-- -----------------------------------------------------------------------------
-- RLS (§8): public read to authenticated; writes are service-role only (the
-- ingestion job) — no insert/update/delete policy or grant for
-- anon/authenticated at all. Matches the schema-level default-privilege
-- backstop (20260719130400), which already leaves this table with zero
-- anon/authenticated access until explicitly granted; only SELECT is granted
-- below, mirroring activity_types.
-- -----------------------------------------------------------------------------
alter table public.exercises enable row level security;

create policy exercises_select_all
  on public.exercises
  for select
  to authenticated
  using (true);

grant select on public.exercises to authenticated;

-- -----------------------------------------------------------------------------
-- Illustrative starter seed (NOT the real ingestion — see migration header).
-- A dozen common movements across mechanics/equipment/field-set combinations
-- so RLS/grants/read behavior can be verified live and the app has something
-- to log against before backend-builder's ingestion job lands.
-- -----------------------------------------------------------------------------
insert into public.exercises
  (slug, name, primary_muscle, secondary_muscles, equipment, mechanic, force_vector,
   is_distance_based, is_time_based, is_weighted, is_bodyweight, source, is_active)
values
  ('barbell-back-squat',   'Barbell Back Squat',   'quadriceps', array['glutes','hamstrings']::public.muscle_group[], 'barbell',   'compound',  'push',   false, false, true,  false, 'milelift_authored', true),
  ('barbell-deadlift',     'Barbell Deadlift',     'back',       array['glutes','hamstrings']::public.muscle_group[], 'barbell',   'compound',  'pull',   false, false, true,  false, 'milelift_authored', true),
  ('barbell-bench-press',  'Barbell Bench Press',  'chest',      array['triceps','shoulders']::public.muscle_group[], 'barbell',   'compound',  'push',   false, false, true,  false, 'milelift_authored', true),
  ('overhead-press',       'Overhead Press',       'shoulders',  array['triceps']::public.muscle_group[],             'barbell',   'compound',  'push',   false, false, true,  false, 'milelift_authored', true),
  ('barbell-row',          'Barbell Row',          'back',       array['biceps','lats']::public.muscle_group[],       'barbell',   'compound',  'pull',   false, false, true,  false, 'milelift_authored', true),
  ('pull-up',              'Pull-Up',              'lats',       array['biceps','back']::public.muscle_group[],       'bodyweight','compound',  'pull',   false, false, false, true,  'milelift_authored', true),
  ('push-up',              'Push-Up',              'chest',      array['triceps','shoulders']::public.muscle_group[], 'bodyweight','compound',  'push',   false, false, false, true,  'milelift_authored', true),
  ('dumbbell-bicep-curl',  'Dumbbell Bicep Curl',  'biceps',     '{}'::public.muscle_group[],                          'dumbbell',  'isolation', 'pull',   false, false, true,  false, 'milelift_authored', true),
  ('cable-tricep-pushdown','Cable Tricep Pushdown','triceps',    '{}'::public.muscle_group[],                          'cable',     'isolation', 'push',   false, false, true,  false, 'milelift_authored', true),
  ('leg-press',            'Leg Press',            'quadriceps', array['glutes']::public.muscle_group[],               'machine',   'compound',  'push',   false, false, true,  false, 'milelift_authored', true),
  ('plank',                'Plank',                'abs',        array['obliques']::public.muscle_group[],             'bodyweight','isolation', 'static', false, true,  false, true,  'milelift_authored', true),
  ('treadmill-run',        'Treadmill Run',        'cardio',     array['quadriceps','hamstrings']::public.muscle_group[], 'machine', null,        null,     true,  true,  false, false, 'milelift_authored', true)
on conflict (slug) do nothing;
