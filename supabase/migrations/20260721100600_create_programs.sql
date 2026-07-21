-- =============================================================================
-- Phase 2 — Module C: programs (CORE-14 multi-workout programs, owner-owned)
-- Design ref: docs/architecture/phase-2-module-c.md §1.8, §8, §11
--
-- An ordered/scheduled collection of templates ("PPL 6-day", "5/3/1"). Phase 2
-- = the builder data model + associating templates to a program; the
-- calendar/auto-progression engine is later (§11) -- deliberately not built here.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100600_create_programs.sql
-- =============================================================================

create table public.programs (
  id             uuid primary key default gen_random_uuid(),

  user_id        uuid not null references public.profiles (id) on delete cascade,

  name           text not null
    constraint programs_name_not_blank_chk check (length(trim(name)) > 0),
  description    text,
  length_weeks   integer
    constraint programs_length_weeks_positive_chk check (length_weeks is null or length_weeks > 0),

  deleted_at     timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.programs is
  'CORE-14 multi-workout program (§1.8): the builder data model + template '
  'association only, not a scheduling/auto-progression engine (§11).';

create index idx_programs_user
  on public.programs (user_id)
  where deleted_at is null;

create trigger trg_programs_set_updated_at
  before update on public.programs
  for each row
  execute function public.set_updated_at();

create trigger trg_programs_force_insert_audit_timestamps
  before insert on public.programs
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, SELECT/INSERT/UPDATE; no client DELETE (soft-delete
-- via deleted_at, mirroring workout_templates).
-- -----------------------------------------------------------------------------
alter table public.programs enable row level security;

create policy programs_select_own
  on public.programs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy programs_insert_own
  on public.programs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy programs_update_own
  on public.programs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.programs to authenticated;
grant update (name, description, length_weeks, deleted_at) on public.programs to authenticated;
