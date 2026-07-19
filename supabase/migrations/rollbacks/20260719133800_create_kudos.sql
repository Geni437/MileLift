-- Rollback for 20260719133800_create_kudos.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists kudos_delete_own on public.kudos;
drop policy if exists kudos_select_visible on public.kudos;
drop policy if exists kudos_insert_own on public.kudos;

drop trigger if exists trg_kudos_force_insert_created_at on public.kudos;
drop trigger if exists trg_kudos_enforce_integrity on public.kudos;

drop function if exists public.enforce_kudos_target_owner_matches_spine();

drop index if exists public.idx_kudos_target_owner_created_at;
drop index if exists public.uq_kudos_timeline_event_actor_reaction;

drop table if exists public.kudos cascade;

drop type if exists public.kudos_reaction_type;
