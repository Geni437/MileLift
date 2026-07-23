import { AppState, type AppStateStatus } from 'react-native';
import * as Network from 'expo-network';

import { supabase } from '../lib/supabase';
import { profileRepository } from '../db/repositories/profileRepository';
import { profileHealthRepository } from '../db/repositories/profileHealthRepository';
import { consentRepository } from '../db/repositories/consentRepository';
import {
  pullActivities,
  pullActivityAchievements,
  pullActivityRoutes,
  pullPersonalRecords,
  pushActivities,
  refreshActivityTypesIfNeeded,
} from './activitySync';
import { wearableLinksRepository } from '../db/repositories/wearableLinksRepository';
import {
  pullBodyMeasurements,
  pullBodyweightLogs,
  pullCustomExercises,
  pullPrograms,
  pullProgressPhotos,
  pullStrengthAchievements,
  pullStrengthRecords,
  pullWorkoutSessions,
  pullWorkoutTemplates,
  pushBodyMeasurements,
  pushBodyweightLogs,
  pushCustomExercises,
  pushPrograms,
  pushProgressPhotos,
  pushWorkoutSessions,
  pushWorkoutTemplates,
  refreshExerciseLibraryIfStale,
} from './workoutSync';
import {
  pullCustomFoods,
  pullFoodLogEntries,
  pullManualBurnLogs,
  pullSavedMeals,
  pullWaterIntakeLogs,
  pushCustomFoods,
  pushFoodLogEntries,
  pushManualBurnLogs,
  pushSavedMeals,
  pushWaterIntakeLogs,
} from './nutritionSync';
import type { ProfileRow } from '../db/repositories/profileRepository';
import type { ProfileHealthRow } from '../db/repositories/profileHealthRepository';
import type { ConsentRow } from '../db/repositories/consentRepository';

/**
 * The Phase-0-scoped sync engine: profile / profile_health / user_consents
 * only (task brief: "scoped here to just the profile/auth data, not the full
 * timeline sync engine"). Push path uses upsert-by-primary-key so a retried
 * flush after a flaky network is always safe (architecture §3.4 idempotency)
 * — profiles/profile_health are keyed by the owner's uuid already; consents
 * carry a client-generated uuid `id`.
 *
 * Triggers (mobile-architecture-standards: "sync opportunistically," not a
 * persistent-connection assumption):
 *   - once at app start / sign-in,
 *   - on AppState -> 'active' (foreground),
 *   - on a network-state transition into "connected",
 *   - immediately after each local optimistic write (best-effort; failures
 *     stay `pending`/`failed` and are retried by the above).
 */
let listenersAttached = false;
let currentUserId: string | null = null;
let syncing = false;

export function setSyncUser(userId: string | null): void {
  currentUserId = userId;
}

export function attachSyncTriggers(): () => void {
  if (listenersAttached) return () => {};
  listenersAttached = true;

  const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void runSync('foreground');
  });

  const networkSub = Network.addNetworkStateListener((event) => {
    if (event.isConnected && event.isInternetReachable !== false) {
      void runSync('reconnect');
    }
  });

  return () => {
    appStateSub.remove();
    networkSub.remove();
    listenersAttached = false;
  };
}

export async function runSync(_reason: 'startup' | 'foreground' | 'reconnect' | 'manual' | 'post-write'): Promise<void> {
  // `syncing` must flip to true synchronously, before any `await` — two
  // triggers firing close together (e.g. the AppState-active listener and
  // the network-reconnect listener) would otherwise both pass this guard
  // while it's still false, and run their entire push chain concurrently,
  // defeating the single-in-flight guarantee save-workout-session-v1 §2.6
  // depends on to keep its PR-detection race narrow/cross-device-only
  // (live-reproduced: this exact race let two same-device syncs double-log
  // a PR achievement for one workout).
  if (!currentUserId || syncing) return;
  syncing = true;

  try {
    const net = await Network.getNetworkStateAsync();
    if (!net.isConnected || net.isInternetReachable === false) return;

    await pushProfile(currentUserId);
    await pushProfileHealth(currentUserId);
    await pushConsents();
    await pullProfile(currentUserId);
    await pullConsents(currentUserId);

    // Phase 1 — Module A. Activity types is cheap/rarely-changing reference
    // data, refreshed once (cached thereafter). Push before pull so this
    // device's own writes are reflected before pulling anyone else's.
    await refreshActivityTypesIfNeeded();
    await pushActivities(currentUserId);
    await pushWearableLinks();
    await pullActivities(currentUserId);
    // Runs right after pullActivities so a freshly-pulled (or fresh-install/
    // second-device) activity's route is backfilled in the same pass —
    // see pullActivityRoutes' own doc comment for why this isn't folded
    // into pullActivities itself (activity_routes is a separate table with
    // its own write-once/backfill semantics).
    await pullActivityRoutes(currentUserId);
    await pullPersonalRecords(currentUserId);
    await pullActivityAchievements(currentUserId);

    // Phase 2 — Module C. Exercise library refreshes on its own cadence
    // (independent of the user timeline, §9.6); custom exercises/templates/
    // programs push before workout sessions so a freshly-created custom
    // exercise or template a session references has already landed
    // server-side by the time the session's own save runs. Workout sessions
    // push is the gate-critical, strictly-sequential piece (RPC §2.6) —
    // pushWorkoutSessions itself loops sequentially, never Promise.all.
    await refreshExerciseLibraryIfStale();
    await pushCustomExercises(currentUserId);
    await pushWorkoutTemplates(currentUserId);
    await pushPrograms(currentUserId);
    await pushWorkoutSessions(currentUserId);
    await pushBodyweightLogs(currentUserId);
    await pushBodyMeasurements(currentUserId);
    await pushProgressPhotos(currentUserId);

    await pullCustomExercises(currentUserId);
    await pullWorkoutTemplates(currentUserId);
    await pullPrograms(currentUserId);
    await pullWorkoutSessions(currentUserId);
    await pullStrengthRecords(currentUserId);
    await pullStrengthAchievements(currentUserId);
    await pullBodyweightLogs(currentUserId);
    await pullBodyMeasurements(currentUserId);
    await pullProgressPhotos(currentUserId);

    // Phase 3 — Module B. Custom foods / saved meals push before meals so a
    // freshly-created custom food or saved meal a log references has
    // already landed server-side by the time it's read back. Meals push is
    // the gate-critical, strictly-sequential piece (RPC §2.6 discipline) —
    // pushFoodLogEntries itself loops sequentially, never Promise.all.
    await pushCustomFoods(currentUserId);
    await pushSavedMeals(currentUserId);
    await pushFoodLogEntries(currentUserId);
    await pushWaterIntakeLogs(currentUserId);
    await pushManualBurnLogs(currentUserId);

    await pullCustomFoods(currentUserId);
    await pullSavedMeals(currentUserId);
    await pullFoodLogEntries(currentUserId);
    await pullWaterIntakeLogs(currentUserId);
    await pullManualBurnLogs(currentUserId);
  } finally {
    syncing = false;
  }
}

async function pushWearableLinks(): Promise<void> {
  const pending = await wearableLinksRepository.getUnsynced();
  for (const link of pending) {
    const { error } = await supabase.from('wearable_links').upsert(
      {
        id: link.id,
        timeline_event_id: link.timelineEventId,
        user_id: link.userId,
        provider: link.provider,
        direction: link.direction,
        external_record_id: link.externalRecordId,
        synced_at: link.syncedAt,
      },
      { onConflict: 'id' }
    );
    if (error) {
      await wearableLinksRepository.markFailed(link.id, error.message);
    } else {
      await wearableLinksRepository.markSynced(link.id);
    }
  }
}

async function pushProfile(userId: string): Promise<void> {
  const pending = await profileRepository.getUnsynced();
  const mine = pending.find((p) => p.id === userId);
  if (!mine) return;

  const { data, error } = await supabase
    .from('profiles')
    .upsert(
      {
        id: mine.id,
        username: mine.username,
        display_name: mine.displayName,
        avatar_url: mine.avatarUrl,
        unit_weight: mine.unitWeight,
        unit_distance: mine.unitDistance,
        default_timezone: mine.defaultTimezone,
        deletion_requested_at: mine.deletionRequestedAt,
      },
      { onConflict: 'id' }
    )
    .select()
    .single<ProfileRow>();

  if (error) {
    await profileRepository.markFailed(userId, error.message);
    return;
  }
  if (data) {
    await profileRepository.reconcileFromServerForce(data);
  }
}

async function pushProfileHealth(userId: string): Promise<void> {
  const pending = await profileHealthRepository.getUnsynced();
  const mine = pending.find((p) => p.userId === userId);
  if (!mine) return;

  const { data, error } = await supabase
    .from('profile_health')
    .upsert(
      {
        user_id: mine.userId,
        sex: mine.sex,
        date_of_birth: mine.dateOfBirth,
        height_cm: mine.heightCm,
      },
      { onConflict: 'user_id' }
    )
    .select()
    .single<ProfileHealthRow>();

  if (error) {
    // The DB-level consent trigger (enforce_health_consent) rejects this
    // with a specific Postgres error if the health consent row hasn't
    // synced yet (e.g. grant + edit happened back-to-back offline and the
    // consent push hasn't landed). Surface that distinctly rather than a
    // generic failure, so the UI/ops log can tell "no connection" apart
    // from "consent not yet recognized server-side."
    const message = error.code === '42501' ? 'Waiting for health consent to sync first.' : error.message;
    await profileHealthRepository.markFailed(userId, message);
    return;
  }
  if (data) {
    await profileHealthRepository.markSynced(data);
  }
}

async function pushConsents(): Promise<void> {
  const pending = await consentRepository.getUnsynced();
  for (const consent of pending) {
    // Consents are append-only server-side (architecture §6): the ACL only
    // grants `authenticated` UPDATE on `revoked_at`, never the other
    // columns, and a blanket upsert's implicit `ON CONFLICT DO UPDATE SET
    // <every column>` requires UPDATE privilege on all of them to even
    // plan the statement -- regardless of whether a conflict actually
    // occurs. So a revoke goes through a scoped `.update(revoked_at)`
    // (matching consentRepository.revoke's own local write), and a fresh
    // grant is a plain `.insert()` (id is a client-generated UUID, never
    // expected to collide) -- never `.upsert()`.
    if (consent.revokedAt) {
      const { data, error } = await supabase
        .from('user_consents')
        .update({ revoked_at: consent.revokedAt })
        .eq('id', consent.id)
        .select('id');
      if (error) {
        await consentRepository.markFailed(consent.id, error.message);
        continue;
      }
      if (data && data.length > 0) {
        await consentRepository.markSynced(consent.id);
        continue;
      }
      // Matched no row: granted and revoked entirely offline before the
      // grant itself ever synced. Fall through to insert the full
      // already-revoked row.
    }

    const { error } = await supabase.from('user_consents').insert({
      id: consent.id,
      user_id: consent.userId,
      category: consent.category,
      purpose_version: consent.purposeVersion,
      granted_at: consent.grantedAt,
      revoked_at: consent.revokedAt,
    });

    if (error) {
      await consentRepository.markFailed(consent.id, error.message);
    } else {
      await consentRepository.markSynced(consent.id);
    }
  }
}

async function pullProfile(userId: string): Promise<void> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle<ProfileRow>();
  if (error || !data) return;
  await profileRepository.reconcileFromServer(data);
}

async function pullConsents(userId: string): Promise<void> {
  const { data, error } = await supabase.from('user_consents').select('*').eq('user_id', userId);
  if (error || !data) return;
  await consentRepository.reconcileFromServer(data as ConsentRow[]);
}
