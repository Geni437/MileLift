-- =============================================================================
-- Phase 2 — Module C: progress_photos + progress_photo_images (CORE-16)
-- Design ref: docs/architecture/phase-2-module-c.md §1.9, §6, §7, §8, §12 items 5/6/8
--
-- Adds the `body_image` consent category (add-only enum value, per
-- supabase-standards: never remove/rename an existing value) AND the two
-- progress-photo tables AND their consent-gating trigger, RLS, and grants,
-- ALL IN THIS ONE MIGRATION -- per the architecture doc's explicit remaining
-- action for db-engineer (§12): "add the body_image enum value plus its
-- consent-gating trigger in the same migration that creates the
-- progress-photo tables — RLS + grants + consent gate all in one migration,
-- no exceptions." This is a deliberate divergence from this project's usual
-- one-concern-per-migration style, done because the person explicitly
-- required it, not an oversight.
--
-- Body imagery is the module's most sensitive data (§6: "often near-nude").
-- Gated on a DEDICATED body_image consent category (§12 item 5, diverging
-- from the architect's reuse-health+camera recommendation) so a user can
-- allow health sync while keeping progress photos off, or revoke photo
-- consent alone without losing health-data logging.
--
-- One progress_photo timeline event per photo OCCASION (§12 item 8,
-- confirmed over the per-image alternative), with progress_photo_images as
-- the per-pose child. No image bytes in Postgres -- object_path points into
-- the owner-only progress-photos Storage bucket (next migration).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721101200_create_progress_photos.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Add-only enum extension. Not used anywhere else in this same transaction
-- as a bare literal outside a function body (the enforce_progress_*_consent
-- triggers below reference it only inside plpgsql function bodies, which are
-- not type-checked/executed at CREATE FUNCTION time) -- safe within a single
-- migration transaction per Postgres's "new enum value not usable in the
-- same transaction it was added" restriction.
-- -----------------------------------------------------------------------------
alter type public.consent_category add value 'body_image';

create type public.photo_pose as enum ('front', 'side', 'back', 'other');

comment on type public.photo_pose is
  'Pose for a progress-photo image within an occasion (§1.9). Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.progress_photos (the occasion)
-- -----------------------------------------------------------------------------
create table public.progress_photos (
  timeline_event_id  uuid primary key references public.timeline_events (id) on delete cascade,

  user_id             uuid not null references public.profiles (id) on delete cascade,

  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.progress_photos is
  'CORE-16 progress-photo occasion, 1:1 with a progress_photo timeline event '
  '(§1.9, §12 item 8: one event per occasion, not per image). No image bytes '
  'here -- see progress_photo_images.object_path + the progress-photos '
  'Storage bucket. Gated on an active body_image consent row (§6, §12 item 5).';

create or replace function public.enforce_progress_photos_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id    uuid;
  v_spine_event_type public.timeline_event_type;
begin
  select user_id, event_type
    into v_spine_user_id, v_spine_event_type
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'progress_photos write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'progress_photos.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'progress_photo' then
    raise exception
      'progress_photos write rejected: timeline_events.event_type (%) for event % is not progress_photo',
      v_spine_event_type, new.timeline_event_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'body_image'
      and revoked_at is null
  ) then
    raise exception
      'progress_photos write rejected: no active body_image-category consent on file for user % (CONSENT_REQUIRED_BODY_IMAGE)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_progress_photos_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) event_type '
  'must be progress_photo, (3) an active body_image consent row is required '
  '-- deliberately NOT the health or camera category (§6, §12 item 5).';

revoke execute on function public.enforce_progress_photos_integrity() from public, anon, authenticated;

create trigger trg_progress_photos_enforce_integrity
  before insert or update on public.progress_photos
  for each row
  execute function public.enforce_progress_photos_integrity();

create trigger trg_progress_photos_set_updated_at
  before update on public.progress_photos
  for each row
  execute function public.set_updated_at();

create trigger trg_progress_photos_force_insert_audit_timestamps
  before insert on public.progress_photos
  for each row
  execute function public.force_insert_audit_timestamps();

alter table public.progress_photos enable row level security;

create policy progress_photos_select_own
  on public.progress_photos
  for select
  to authenticated
  using (user_id = auth.uid());

create policy progress_photos_insert_own
  on public.progress_photos
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy progress_photos_update_own
  on public.progress_photos
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.progress_photos to authenticated;
grant update (notes) on public.progress_photos to authenticated;

-- -----------------------------------------------------------------------------
-- public.progress_photo_images (child, one row per pose)
-- -----------------------------------------------------------------------------
create table public.progress_photo_images (
  id                  uuid primary key default gen_random_uuid(),

  timeline_event_id   uuid not null references public.progress_photos (timeline_event_id) on delete cascade,
  -- Denormalized for RLS; consistency with progress_photos.user_id enforced
  -- by the trigger below.
  user_id             uuid not null references public.profiles (id) on delete cascade,

  pose                 public.photo_pose not null,
  -- Deterministic Storage path per §1.9: {user_id}/{timeline_event_id}/
  -- {pose}.jpg, inside the owner-only progress-photos bucket (next
  -- migration). CHECK-enforced to actually match this row's own
  -- user_id/timeline_event_id/pose, at the DB layer, mirroring
  -- activity_routes.raw_track_object_path -- never trusting a client-supplied
  -- string.
  object_path          text not null,
  checksum              text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint progress_photo_images_object_path_chk check (
    object_path = user_id::text || '/' || timeline_event_id::text || '/' || pose::text || '.jpg'
  ),
  -- The deterministic path is 1:1 with (timeline_event_id, pose) -- a second
  -- DB row for the same pose within the same occasion would collide on the
  -- exact same Storage object path anyway, so this unique constraint just
  -- makes that invariant explicit and DB-enforced (db-engineer addition, not
  -- verbatim from the doc -- flagged in the task report).
  constraint uq_progress_photo_images_event_pose unique (timeline_event_id, pose)
);

comment on table public.progress_photo_images is
  'CORE-16 one row per pose within a progress_photos occasion (§1.9). No '
  'image bytes -- object_path points into the progress-photos Storage bucket. '
  'unique(timeline_event_id, pose): at most one image per pose per occasion, '
  'matching the deterministic Storage path.';
comment on column public.progress_photo_images.object_path is
  'Deterministic path: {user_id}/{timeline_event_id}/{pose}.jpg inside the '
  'progress-photos bucket. CHECK-enforced to match this row''s own identity.';

create or replace function public.enforce_progress_photo_images_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_parent_user_id uuid;
begin
  select user_id into v_parent_user_id
    from public.progress_photos
    where timeline_event_id = new.timeline_event_id;

  if v_parent_user_id is null then
    raise exception
      'progress_photo_images write rejected: no progress_photos row found for timeline_event_id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_parent_user_id <> new.user_id then
    raise exception
      'progress_photo_images.user_id (%) does not match progress_photos.user_id (%) for event %',
      new.user_id, v_parent_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  -- Checked directly (not only transitively via the parent occasion's own
  -- insert-time check) -- an image can be uploaded/added after the occasion
  -- row already exists, and consent may have been revoked in between (§6:
  -- "revoking body_image blocks new progress-photo writes").
  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'body_image'
      and revoked_at is null
  ) then
    raise exception
      'progress_photo_images write rejected: no active body_image-category consent on file for user % (CONSENT_REQUIRED_BODY_IMAGE)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_progress_photo_images_integrity() is
  'Trigger: (1) user_id must match the parent progress_photos row''s user_id, '
  '(2) an active body_image consent row is required (checked directly, not '
  'only transitively). §1.9, §6.';

revoke execute on function public.enforce_progress_photo_images_integrity() from public, anon, authenticated;

create trigger trg_progress_photo_images_enforce_integrity
  before insert or update on public.progress_photo_images
  for each row
  execute function public.enforce_progress_photo_images_integrity();

create trigger trg_progress_photo_images_set_updated_at
  before update on public.progress_photo_images
  for each row
  execute function public.set_updated_at();

create trigger trg_progress_photo_images_force_insert_audit_timestamps
  before insert on public.progress_photo_images
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, body_image-consent-gated write (triggers above),
-- never widened. SELECT/INSERT/UPDATE, no client DELETE (no deleted_at
-- column on either table; soft-delete is via timeline_events.deleted_at,
-- mirroring activity_details/bodyweight_logs). §12 item 6: the 30-day grace
-- window is the platform default, applied at the spine level -- no special
-- instant/permanent path here. The account-deletion job additionally purges
-- this user's progress-photos/{user_id}/... Storage objects, since cascades
-- don't reach Storage (§7 -- backend-builder scope, out of this migration).
-- -----------------------------------------------------------------------------
alter table public.progress_photo_images enable row level security;

create policy progress_photo_images_select_own
  on public.progress_photo_images
  for select
  to authenticated
  using (user_id = auth.uid());

create policy progress_photo_images_insert_own
  on public.progress_photo_images
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy progress_photo_images_update_own
  on public.progress_photo_images
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.progress_photo_images to authenticated;
-- pose/object_path are excluded from UPDATE -- both are identity-forming
-- (the natural key + its CHECK-enforced deterministic Storage path); a
-- re-upload at the same deterministic path is a Storage-layer operation
-- (see the progress-photos bucket migration for why the storage.objects
-- UPDATE policy is separately needed for a same-path re-upload), not a
-- change to this row's own columns. checksum is mutable so a re-uploaded
-- image's checksum can be refreshed after a retried upload.
grant update (checksum) on public.progress_photo_images to authenticated;
