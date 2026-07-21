-- Rollback for 20260721100200_create_exercise_media_storage_bucket.sql
-- Safe to re-run; drops policies, then the bucket. Does NOT delete any
-- objects already uploaded to the bucket -- that is a data-loss operation
-- requiring a separate, deliberate decision (see rollbacks/README.md).

drop policy if exists exercise_media_bucket_select_authenticated on storage.objects;

delete from storage.buckets where id = 'exercise-media';
