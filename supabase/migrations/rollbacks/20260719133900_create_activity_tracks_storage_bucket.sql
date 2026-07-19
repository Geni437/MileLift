-- Rollback for 20260719133900_create_activity_tracks_storage_bucket.sql
-- Safe to re-run; drops in dependency order with IF EXISTS.
-- NOTE: this removes the bucket row too, which only succeeds if the bucket is
-- empty (Storage enforces this) -- purge objects first if this is being run
-- post-deploy against a bucket that has already taken uploads.

drop policy if exists activity_tracks_update_own on storage.objects;
drop policy if exists activity_tracks_insert_own on storage.objects;
drop policy if exists activity_tracks_select_own on storage.objects;

delete from storage.buckets where id = 'activity-tracks';
