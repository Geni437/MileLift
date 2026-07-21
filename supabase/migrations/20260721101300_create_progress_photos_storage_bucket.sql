-- =============================================================================
-- Phase 2 — Module C: progress-photos Storage bucket
-- Design ref: docs/architecture/phase-2-module-c.md §1.9, §6, §7, §8
--
-- Owner-only, fail-closed, path-prefixed by user_id: {user_id}/
-- {timeline_event_id}/{pose}.jpg (matches progress_photo_images.object_path's
-- CHECK constraint exactly). `public = false` -- signed URLs with short
-- expiry are the only read path (§6, supabase-standards), mirroring
-- activity-tracks. This is the module's most sensitive content (often
-- near-nude, §6) -- never a public bucket URL.
--
-- No DELETE policy: matches the no-client-DELETE default used throughout
-- this schema (§12 item 6 -- 30-day grace window, platform default). The
-- account-deletion hard-purge job must additionally purge this user's
-- progress-photos/{user_id}/... Storage objects, since cascades don't reach
-- Storage (§7 -- backend-builder scope, out of this migration).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721101300_create_progress_photos_storage_bucket.sql
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'progress-photos',
  'progress-photos',
  false,
  15728640, -- 15 MiB per image -- comfortably covers a full-resolution phone photo
  array['image/jpeg', 'image/png', 'image/heic']
)
on conflict (id) do nothing;

create policy progress_photos_bucket_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy progress_photos_bucket_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE is required, not just INSERT: a retried/re-uploaded photo at the
-- same deterministic path is an upsert at the Storage API layer, which needs
-- both INSERT and UPDATE privilege on the existing storage.objects row when
-- the object already exists (mirrors activity-tracks).
create policy progress_photos_bucket_update_own
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
