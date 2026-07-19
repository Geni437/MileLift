-- =============================================================================
-- security-auditor L2 (optional, addressed since already in the grants) —
-- forgeable audit columns at INSERT time.
--
-- Table-wide INSERT grants (profiles, user_consents, profile_health,
-- timeline_events all grant unrestricted-column INSERT to authenticated) mean
-- a client can currently supply an arbitrary `created_at`/`updated_at` in an
-- insert payload despite both columns being documented as server-controlled
-- (§1.2/§2: "created_at — Server insert time", "updated_at — Server-
-- maintained (trigger)"). Blast radius is own-rows-only (RLS still scopes
-- which row; this is a self-directed data-integrity issue, not a
-- cross-user one), but it's cheap to close properly.
--
-- Scope note, deliberately narrower than a literal reading of the security
-- report: `source` and `client_created_at` on timeline_events are NOT forced
-- here, even though they were mentioned alongside created_at/updated_at.
-- Both are legitimately client-supplied fields by design (architecture §1.2:
-- `client_created_at` = "When the client first created the row (offline
-- clock)... never trusted for security" — its entire purpose is to record
-- what the client said, precisely because it is NOT trusted, not to mirror a
-- server timestamp; `source` = "How the row originated" (manual/wearable/
-- import/ai_parsed/system), which only the client/ingestion path can know).
-- Forcing either of these server-side would silently break real
-- functionality (a synced wearable event could never be tagged `source =
-- 'wearable'`, an offline-created event could never carry its real offline
-- timestamp). Only the two columns actually documented as server-owned are
-- addressed here.
--
-- Mechanism: a BEFORE INSERT trigger, not a narrower column-scoped INSERT
-- GRANT. Chosen deliberately after today's experience with column-scoped
-- UPDATE grants (20260719112010 / 20260719112940): those turned out to be
-- fragile in practice (a table-level REVOKE unexpectedly stripped
-- previously-issued column-level grants too, verified live) and are, as a
-- class, exactly the kind of default-privilege-dependent mechanism M3 is
-- moving away from. A trigger that unconditionally overwrites
-- NEW.created_at/NEW.updated_at on INSERT is deterministic and does not
-- depend on ACL/grant semantics at all — the client's payload can still
-- *contain* a spoofed value, it just never reaches storage.
--
-- This complements, not replaces, the existing `set_updated_at()` BEFORE
-- UPDATE trigger (which already forces updated_at correctly on every UPDATE)
-- -- this migration's trigger only needs to additionally cover INSERT time,
-- and covers created_at at insert time too (created_at is never touched
-- again after insert, so it needs no UPDATE-time equivalent).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719130646_force_server_controlled_audit_timestamps.sql
-- =============================================================================

create or replace function public.force_insert_audit_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.created_at = now();
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.force_insert_audit_timestamps() from public, anon, authenticated;

comment on function public.force_insert_audit_timestamps() is
  'Trigger-only helper: forces NEW.created_at and NEW.updated_at to now() on '
  'INSERT, ignoring any client-supplied value for those two columns. Not '
  'intended for direct RPC invocation.';

create trigger trg_profiles_force_insert_audit_timestamps
  before insert on public.profiles
  for each row
  execute function public.force_insert_audit_timestamps();

create trigger trg_user_consents_force_insert_audit_timestamps
  before insert on public.user_consents
  for each row
  execute function public.force_insert_audit_timestamps();

create trigger trg_profile_health_force_insert_audit_timestamps
  before insert on public.profile_health
  for each row
  execute function public.force_insert_audit_timestamps();

create trigger trg_timeline_events_force_insert_audit_timestamps
  before insert on public.timeline_events
  for each row
  execute function public.force_insert_audit_timestamps();
