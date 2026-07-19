-- =============================================================================
-- Phase 1 — Module A: activity-tracks Storage bucket
-- Design ref: docs/architecture/phase-1-module-a.md §2.1, §6, §8
--
-- Full-resolution raw GPS track blobs, one per activity, uploaded once on
-- finish (never streamed point-by-point, §2). Owner-only, fail-closed,
-- path-prefixed by user_id: {user_id}/{timeline_event_id}/track.bin (the
-- "activity-tracks/" prefix in activity_routes.raw_track_object_path is the
-- bucket name itself; the object `name` inside the bucket is just
-- {user_id}/{timeline_event_id}/track.bin -- see that column's CHECK
-- constraint for how the two are kept consistent).
--
-- `public = false` is what makes short-expiry signed URLs the only read path
-- (Phase 0 §6, supabase-standards) -- there is no public bucket URL.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133900_create_activity_tracks_storage_bucket.sql
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'activity-tracks',
  'activity-tracks',
  false,
  104857600, -- 100 MiB per blob -- a full-res multi-hour GPS+HR track comfortably fits well under this
  array['application/octet-stream']
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- storage.objects policies for this bucket. RLS is already enabled on
-- storage.objects project-wide (Supabase-managed); these are additive
-- policies scoped to bucket_id = 'activity-tracks' via a `to authenticated` +
-- path-prefix check, matching the fail-closed table-RLS default
-- (supabase-standards).
--
-- storage.foldername(name) splits the object path on '/' and returns the
-- folder segments as text[]; segment 1 must equal the caller's own
-- auth.uid(), enforcing the {user_id}/... prefix from §2.1.
--
-- No DELETE policy: matches the no-client-DELETE default used throughout
-- this schema. Orphan reclamation (failed-upload GC) and account-deletion
-- purge of a user's track objects both run under service_role (Storage GC
-- job / account hard-purge job, backend-builder scope per §7), which bypasses
-- storage.objects RLS entirely -- so no owner DELETE policy is needed here.
-- -----------------------------------------------------------------------------
create policy activity_tracks_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'activity-tracks'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy activity_tracks_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'activity-tracks'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE is required, not just INSERT: a retried/re-uploaded track at the
-- same deterministic path (§2.1: "re-upload overwrites") is performed by the
-- Storage API as an upsert, which needs both INSERT and UPDATE privilege on
-- the existing storage.objects row when the object already exists.
create policy activity_tracks_update_own
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'activity-tracks'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'activity-tracks'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
