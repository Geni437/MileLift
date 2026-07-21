-- Rollback for 20260721101200_create_progress_photos.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
--
-- IMPORTANT LIMITATION: Postgres has no `ALTER TYPE ... DROP VALUE`. The
-- `body_image` value added to public.consent_category by the forward
-- migration CANNOT be removed by this (or any) rollback script. This is a
-- known, accepted one-way aspect of enum extension in Postgres and is called
-- out explicitly here rather than silently omitted (db-schema-standards:
-- "every migration has a working down/reversal, even if reversal means
-- safely no-ops on already-migrated data"). If the body_image category must
-- truly be removed post-deploy, the only mechanisms are (a) leave the enum
-- value in place but ensure no row ever uses it again (harmless, matches
-- this project's "add-only enum" convention treating this as permanent by
-- design), or (b) a manual, carefully-reviewed `CREATE TYPE ... AS ENUM`
-- swap that rebuilds the type without the value and migrates every
-- dependent column -- a significant, separate operation, not appropriate
-- for a mechanical rollback script.

drop policy if exists progress_photo_images_update_own on public.progress_photo_images;
drop policy if exists progress_photo_images_insert_own on public.progress_photo_images;
drop policy if exists progress_photo_images_select_own on public.progress_photo_images;

drop trigger if exists trg_progress_photo_images_force_insert_audit_timestamps on public.progress_photo_images;
drop trigger if exists trg_progress_photo_images_set_updated_at on public.progress_photo_images;
drop trigger if exists trg_progress_photo_images_enforce_integrity on public.progress_photo_images;

drop function if exists public.enforce_progress_photo_images_integrity();

drop table if exists public.progress_photo_images cascade;

drop policy if exists progress_photos_update_own on public.progress_photos;
drop policy if exists progress_photos_insert_own on public.progress_photos;
drop policy if exists progress_photos_select_own on public.progress_photos;

drop trigger if exists trg_progress_photos_force_insert_audit_timestamps on public.progress_photos;
drop trigger if exists trg_progress_photos_set_updated_at on public.progress_photos;
drop trigger if exists trg_progress_photos_enforce_integrity on public.progress_photos;

drop function if exists public.enforce_progress_photos_integrity();

drop table if exists public.progress_photos cascade;

drop type if exists public.photo_pose;

-- consent_category's `body_image` value is intentionally NOT removed -- see
-- the header note above.
