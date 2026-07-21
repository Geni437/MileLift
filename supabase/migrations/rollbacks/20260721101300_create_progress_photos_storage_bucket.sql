-- Rollback for 20260721101300_create_progress_photos_storage_bucket.sql
-- Safe to re-run; drops policies, then the bucket. Does NOT delete any
-- objects already uploaded to the bucket -- that is a data-loss operation
-- on user health-adjacent imagery requiring a separate, deliberate decision
-- (see rollbacks/README.md).

drop policy if exists progress_photos_bucket_update_own on storage.objects;
drop policy if exists progress_photos_bucket_insert_own on storage.objects;
drop policy if exists progress_photos_bucket_select_own on storage.objects;

delete from storage.buckets where id = 'progress-photos';
