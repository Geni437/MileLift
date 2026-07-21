-- =============================================================================
-- Phase 2 — Module C: exercise-media Storage bucket
-- Design ref: docs/architecture/phase-2-module-c.md §2.2, §6, §8
--
-- Non-sensitive public reference assets (exercise demo images/video) — the
-- opposite posture from the owner-only progress-photos bucket (§8). `public =
-- true` so objects are served via a normal cacheable public URL (§2.2: "served
-- with normal caching"), not short-expiry signed URLs -- there is nothing
-- user-specific or sensitive in this bucket.
--
-- Note on access nuance (flagged in the task report): `public = true` means
-- the direct object URL is fetchable by anyone who has it, regardless of
-- role -- that is the intended behavior for a CDN-style reference-asset
-- bucket and mirrors §2.2's "served with normal caching" language. The
-- `storage.objects` SELECT policy below additionally governs the *Storage
-- API* path (as opposed to the public CDN URL path) and is scoped to
-- `authenticated`, matching the exercises/exercise_media table policies'
-- "public read to authenticated" posture (§8) as closely as a public bucket
-- allows.
--
-- Writes are service-role only (the ingestion/content-backfill job, §2.1) --
-- no insert/update/delete policy for anon/authenticated at all.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100200_create_exercise_media_storage_bucket.sql
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'exercise-media',
  'exercise-media',
  true,
  104857600, -- 100 MiB per asset -- comfortably covers a compressed demo video clip
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']
)
on conflict (id) do nothing;

create policy exercise_media_bucket_select_authenticated
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'exercise-media');

-- Deliberately no insert/update/delete policy for anon/authenticated --
-- writes are service-role only (bypasses storage.objects RLS entirely).
