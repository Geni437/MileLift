import { supabase } from '../lib/supabase';
import { workoutSessionsRepository } from '../db/repositories/workoutSessionsRepository';
import type { ServerWorkoutSessionRow, SetRow } from '../db/repositories/workoutSessionsRepository';
import { exercisesRepository } from '../db/repositories/exercisesRepository';
import { customExercisesRepository } from '../db/repositories/customExercisesRepository';
import { workoutTemplatesRepository } from '../db/repositories/workoutTemplatesRepository';
import { programsRepository } from '../db/repositories/programsRepository';
import { strengthRecordsRepository } from '../db/repositories/strengthRecordsRepository';
import { strengthAchievementsRepository } from '../db/repositories/strengthAchievementsRepository';
import { bodyweightRepository } from '../db/repositories/bodyweightRepository';
import type { ServerBodyweightRow } from '../db/repositories/bodyweightRepository';
import { bodyMeasurementsRepository } from '../db/repositories/bodyMeasurementsRepository';
import { progressPhotosRepository } from '../db/repositories/progressPhotosRepository';
import { syncCursorRepository } from '../db/repositories/syncCursorRepository';
import { uploadProgressPhoto } from '../lib/progressPhotoStorage';
import type { LocalWorkoutSession, StrengthPrMetric } from '../db/types';

/**
 * Push/pull for Module C (strength training & workout logging) — the
 * CORE-17 "hardest item in this phase." Wired into `src/sync/syncEngine.ts`'s
 * `runSync`, same opportunistic triggers as Phase 0/1.
 *
 * The gate-critical piece is `pushWorkoutSessions`: every write is
 * `INSERT ... ON CONFLICT (id) DO UPDATE` at BOTH grains (session id + each
 * set's own id, RPC §2.1/§2.2), so retrying the whole finish — or any subset
 * of it, e.g. a call that DB-committed but whose response never reached this
 * device — is always safe. A removed set is sent as an explicit `deleted_at`
 * tombstone, never as an omission (upsert-present, never delete-omitted).
 *
 * §2.6 sequencing requirement (explicitly flagged in the RPC doc, not
 * optional): pushes run strictly sequentially, one session at a time, one
 * `save_workout_session_v1` call in flight at a time — never
 * `Promise.all(sessions.map(...))`. `runSync`'s own single `syncing` guard
 * additionally prevents two overlapping `runSync` passes on this device.
 */

const EXERCISES_STALE_MS = 24 * 60 * 60 * 1000; // exercise library refresh cadence (§9.6 — independent of the user timeline)
const WORKOUT_SESSIONS_CURSOR_KEY = 'workout_sessions_updated_at';
let lastExerciseLibraryRefreshAt = 0;

type SaveWorkoutSessionRpcResponse = {
  data?: {
    id: string;
    occurred_at: string;
    local_date: string;
    duration_seconds: number;
    total_volume_kg: number | null;
    total_sets: number | null;
    load_score: number | null;
    energy_kcal: number | null;
    set_count: number;
    achievements: { metric: StrengthPrMetric; value: number; source_set_log_id: string }[];
  };
  error?: { code: string; message: string; field: string | null };
};

export async function pushWorkoutSessions(userId: string): Promise<void> {
  const unsynced = await workoutSessionsRepository.getUnsynced(userId);
  // Sequential, never parallel — see module doc comment (RPC §2.6).
  for (const session of unsynced) {
    if (session.deletedAt) {
      await pushWorkoutTombstone(session);
    } else {
      await pushWorkoutSave(session);
    }
  }
}

async function pushWorkoutTombstone(session: LocalWorkoutSession): Promise<void> {
  const wasConfirmed = await workoutSessionsRepository.wasServerConfirmed(session.id);
  if (!wasConfirmed) {
    // Finished and deleted entirely offline before ever syncing — nothing to push.
    await workoutSessionsRepository.purgeLocalOnly(session.id);
    return;
  }
  // Whole-session delete is a direct owner UPDATE on timeline_events, NOT
  // through save_workout_session_v1 (RPC §6/design doc CORE-15 "Delete").
  const { error } = await supabase.from('timeline_events').update({ deleted_at: session.deletedAt }).eq('id', session.id);
  if (error) {
    await workoutSessionsRepository.markFailed(session.id, error.message);
    return;
  }
  await workoutSessionsRepository.markDeleteSynced(session.id);
}

async function pushWorkoutSave(session: LocalWorkoutSession): Promise<void> {
  const dirtySets = await workoutSessionsRepository.getDirtySets(session.id);

  const pSets = dirtySets.map((s) => ({
    id: s.id,
    exercise_id: s.exerciseId,
    custom_exercise_id: s.customExerciseId,
    exercise_name_snapshot: s.exerciseNameSnapshot,
    primary_muscle_snapshot: s.primaryMuscleSnapshot,
    exercise_order: s.exerciseOrder,
    set_number: s.setNumber,
    set_type: s.setType,
    reps: s.reps,
    weight_kg: s.weightKg,
    unit_weight_snapshot: s.unitWeightSnapshot,
    is_bodyweight: s.isBodyweight,
    duration_seconds: s.durationSeconds,
    distance_m: s.distanceM,
    rpe: s.rpe,
    rest_seconds_planned: s.restSecondsPlanned,
    rest_seconds_actual: s.restSecondsActual,
    is_completed: s.isCompleted,
    notes: s.notes,
    deleted_at: s.deletedAt,
    // estimated_1rm_kg is deliberately NOT sent — RPC §2.3: "NEVER accepted
    // from the client," always server-computed via Epley.
  }));

  const rpcParams: Record<string, unknown> = {
    p_id: session.id,
    p_occurred_at: session.occurredAt,
    p_local_date: session.localDate,
    p_event_timezone: session.eventTimezone,
    p_duration_seconds: session.durationSeconds,
    p_sets: pSets,
    p_source: session.source,
    p_visibility: session.visibility,
    p_energy_kcal: session.energyKcal,
    p_title: session.title,
    p_notes: session.notes,
    p_source_template_id: session.sourceTemplateId,
    p_template_name_snapshot: session.templateNameSnapshot,
    p_session_rpe: session.sessionRpe,
    p_calories_source: session.caloriesSource,
    p_client_created_at: session.clientCreatedAt,
  };

  const { data, error } = await supabase.rpc('save_workout_session_v1', rpcParams);

  if (error) {
    // Transport-level failure — distinct from the RPC's own `{ error }`
    // envelope (docs/api/save-workout-session-v1.md §1). The session and
    // every set stay exactly as they are locally; nothing is marked synced.
    await workoutSessionsRepository.markFailed(session.id, error.message);
    return;
  }

  const body = data as SaveWorkoutSessionRpcResponse | null;
  if (body?.error) {
    await workoutSessionsRepository.markFailed(session.id, `${body.error.code}: ${body.error.message}`);
    return;
  }
  const result = body?.data;
  if (!result) {
    await workoutSessionsRepository.markFailed(session.id, 'Empty response from save_workout_session_v1.');
    return;
  }

  await workoutSessionsRepository.markFinishedSynced(session.id, {
    durationSeconds: result.duration_seconds,
    totalVolumeKg: result.total_volume_kg,
    totalSets: result.total_sets,
    loadScore: result.load_score,
    energyKcal: result.energy_kcal,
  });
  // Exactly the sets included in THIS call are now confirmed — any set
  // dirtied again after this point (a later edit) is still resent on the
  // next call, per the per-set idempotency grain (§9.2).
  await workoutSessionsRepository.markSetsSynced(dirtySets.map((s) => s.id));

  await reconcileStrengthPrs(session, result.achievements ?? []);
}

/**
 * Optimistic-then-reconciled strength PR badges (design doc CORE-12/CORE-17
 * coordination note 8): confirms every server-authoritative achievement for
 * this session and quietly retracts any locally-optimistic row the server
 * did NOT confirm — e.g. a second device already logged a heavier set for
 * the same exercise before this one's sync landed. The `strength_records`
 * CACHE itself (not just the achievement log) is corrected shortly after by
 * `pullStrengthRecords`, which runs later in the same `runSync` pass — no
 * bespoke per-session cache reconciliation is needed here.
 */
async function reconcileStrengthPrs(
  session: LocalWorkoutSession,
  serverAchievements: { metric: StrengthPrMetric; value: number; source_set_log_id: string }[]
): Promise<void> {
  const allSets = await workoutSessionsRepository.getSetsForSession(session.id, { includeDeleted: true });
  const setById = new Map(allSets.map((s) => [s.id, s]));

  for (const server of serverAchievements) {
    await strengthAchievementsRepository.confirm(session.id, server.source_set_log_id, session.userId, server.metric, server.value);
  }

  const serverKeys = new Set(serverAchievements.map((a) => `${a.source_set_log_id}:${a.metric}`));
  const localOptimistic = (await strengthAchievementsRepository.getForSession(session.id)).filter((a) => a.isOptimistic);
  for (const local of localOptimistic) {
    const key = `${local.sourceSetLogId}:${local.metric}`;
    if (!serverKeys.has(key)) {
      await strengthAchievementsRepository.retractOptimisticForSession(local.sourceSetLogId, local.metric);
    }
  }

  // Silence an unused-variable lint if setById ever stops being needed by a
  // future edit here — currently reserved for exercise-ref lookups a caller
  // of this function may want (kept minimal deliberately: see doc comment).
  void setById;
}

export async function pullWorkoutSessions(userId: string): Promise<void> {
  const cursor = (await syncCursorRepository.get(userId, WORKOUT_SESSIONS_CURSOR_KEY)) ?? '1970-01-01T00:00:00.000Z';

  const { data, error } = await supabase
    .from('workout_sessions')
    .select('*, timeline_events(*)')
    .eq('user_id', userId)
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(200);

  if (error || !data) return;

  type EmbeddedRow = Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null };

  const rows = (data as EmbeddedRow[])
    .map((row) => {
      const te = Array.isArray(row.timeline_events) ? row.timeline_events[0] : row.timeline_events;
      if (!te) return null;
      return {
        id: te.id,
        user_id: row.user_id,
        title: row.title,
        notes: row.notes,
        occurred_at: te.occurred_at,
        local_date: te.local_date,
        event_timezone: te.event_timezone,
        duration_seconds: te.duration_seconds,
        source_template_id: row.source_template_id,
        template_name_snapshot: row.template_name_snapshot,
        session_rpe: row.session_rpe,
        total_volume_kg: row.total_volume_kg,
        total_sets: row.total_sets,
        calories_source: row.calories_source,
        energy_kcal: te.energy_kcal,
        source: te.source,
        visibility: te.visibility,
        load_score: te.load_score,
        client_created_at: te.client_created_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: te.deleted_at,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let lastUpdatedAt: string | null = null;
  for (const row of rows) {
    await workoutSessionsRepository.reconcileSessionFromServer(row as unknown as ServerWorkoutSessionRow);
    if (typeof row.updated_at === 'string') lastUpdatedAt = row.updated_at;
    await pullSetsForSession(row.id as string, row.user_id as string);
  }
  if (lastUpdatedAt) await syncCursorRepository.set(userId, WORKOUT_SESSIONS_CURSOR_KEY, lastUpdatedAt);
}

async function pullSetsForSession(timelineEventId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('workout_set_logs')
    .select('*')
    .eq('timeline_event_id', timelineEventId)
    .eq('user_id', userId);
  if (error || !data) return;
  await workoutSessionsRepository.reconcileSetsFromServer(timelineEventId, data as SetRow[]);
}

export async function pullStrengthRecords(userId: string): Promise<void> {
  const { data, error } = await supabase.from('strength_records').select('*').eq('user_id', userId);
  if (error || !data) return;
  await strengthRecordsRepository.reconcileAllFromServer(data);
}

export async function pullStrengthAchievements(userId: string): Promise<void> {
  const { data, error } = await supabase.from('strength_achievements').select('*').eq('user_id', userId);
  if (error || !data) return;
  await strengthAchievementsRepository.reconcileAllFromServer(data);
}

/** §9.6: the exercise library refreshes on its own cadence, independent of the user's timeline — not on every sync pass. */
export async function refreshExerciseLibraryIfStale(): Promise<void> {
  const hasAny = await exercisesRepository.hasAny();
  const stale = Date.now() - lastExerciseLibraryRefreshAt > EXERCISES_STALE_MS;
  if (!hasAny || stale) {
    await exercisesRepository.refreshFromServer();
    lastExerciseLibraryRefreshAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Custom exercises
// ---------------------------------------------------------------------------

export async function pushCustomExercises(userId: string): Promise<void> {
  const unsynced = await customExercisesRepository.getUnsynced(userId);
  for (const ex of unsynced) {
    const { error } = await supabase.from('custom_exercises').upsert(
      {
        id: ex.id,
        user_id: ex.userId,
        name: ex.name,
        primary_muscle: ex.primaryMuscle,
        equipment: ex.equipment,
        is_weighted: ex.isWeighted,
        is_bodyweight: ex.isBodyweight,
        is_time_based: ex.isTimeBased,
        is_distance_based: ex.isDistanceBased,
        notes: ex.notes,
        deleted_at: ex.deletedAt,
      },
      { onConflict: 'id' }
    );
    // custom_exercises' column-scoped UPDATE grant (§8.1) covers every
    // column this payload writes except id/user_id/created_at (which never
    // change here), so a whole-row upsert is safe — unlike user_consents.
    if (error) {
      await customExercisesRepository.markFailed(ex.id, error.message);
    } else {
      await customExercisesRepository.markSynced(ex.id);
    }
  }
}

export async function pullCustomExercises(userId: string): Promise<void> {
  const { data, error } = await supabase.from('custom_exercises').select('*').eq('user_id', userId);
  if (error || !data) return;
  await customExercisesRepository.reconcileFromServer(data);
}

// ---------------------------------------------------------------------------
// Workout templates + template exercises
// ---------------------------------------------------------------------------

export async function pushWorkoutTemplates(userId: string): Promise<void> {
  const unsynced = await workoutTemplatesRepository.getUnsynced(userId);
  for (const t of unsynced) {
    const { error } = await supabase.from('workout_templates').upsert(
      { id: t.id, user_id: t.userId, name: t.name, description: t.description, deleted_at: t.deletedAt },
      { onConflict: 'id' }
    );
    if (error) {
      await workoutTemplatesRepository.markFailed(t.id, error.message);
      continue;
    }
    await workoutTemplatesRepository.markSynced(t.id);

    const pendingDeletes = await workoutTemplatesRepository.getPendingExerciseDeletes(t.id);
    for (const row of pendingDeletes) {
      const { error: delError } = await supabase.from('workout_template_exercises').delete().eq('id', row.id);
      if (delError) {
        await workoutTemplatesRepository.markExerciseFailed(row.id, delError.message);
      } else {
        await workoutTemplatesRepository.purgeSyncedDeletedExercise(row.id);
      }
    }

    const pendingExercises = await workoutTemplatesRepository.getUnsyncedExercises(t.id);
    for (const row of pendingExercises) {
      const { error: exError } = await supabase.from('workout_template_exercises').upsert(
        {
          id: row.id,
          template_id: row.templateId,
          user_id: row.userId,
          exercise_id: row.exerciseId,
          custom_exercise_id: row.customExerciseId,
          exercise_order: row.exerciseOrder,
          target_sets: row.targetSets,
          target_reps_low: row.targetRepsLow,
          target_reps_high: row.targetRepsHigh,
          target_weight_kg: row.targetWeightKg,
          target_rest_seconds: row.targetRestSeconds,
          notes: row.notes,
        },
        { onConflict: 'id' }
      );
      // workout_template_exercises' UPDATE grant excludes exercise_id/
      // custom_exercise_id (§8.1: "modeled as delete + re-insert"), which is
      // fine for a whole-row upsert on first INSERT (no conflict yet); an
      // edit to an already-synced row only ever changes the granted mutable
      // columns in this payload, so the upsert stays within grant on update too.
      if (exError) {
        await workoutTemplatesRepository.markExerciseFailed(row.id, exError.message);
      } else {
        await workoutTemplatesRepository.markExerciseSynced(row.id);
      }
    }
  }
}

export async function pullWorkoutTemplates(userId: string): Promise<void> {
  const { data, error } = await supabase.from('workout_templates').select('*').eq('user_id', userId);
  if (error || !data) return;
  await workoutTemplatesRepository.reconcileFromServer(data);
  for (const template of data) {
    const { data: exercises, error: exError } = await supabase
      .from('workout_template_exercises')
      .select('*')
      .eq('template_id', template.id);
    if (exError || !exercises) continue;
    await workoutTemplatesRepository.reconcileExercisesFromServer(template.id, exercises);
  }
}

// ---------------------------------------------------------------------------
// Programs + program workouts
// ---------------------------------------------------------------------------

export async function pushPrograms(userId: string): Promise<void> {
  const unsynced = await programsRepository.getUnsynced(userId);
  for (const p of unsynced) {
    const { error } = await supabase.from('programs').upsert(
      { id: p.id, user_id: p.userId, name: p.name, description: p.description, length_weeks: p.lengthWeeks, deleted_at: p.deletedAt },
      { onConflict: 'id' }
    );
    if (error) {
      await programsRepository.markFailed(p.id, error.message);
      continue;
    }
    await programsRepository.markSynced(p.id);

    const pendingWorkouts = await programsRepository.getUnsyncedWorkouts(p.id);
    for (const w of pendingWorkouts) {
      if (w.deletedLocally) {
        const { error: delError } = await supabase.from('program_workouts').delete().eq('id', w.id);
        if (delError) {
          await programsRepository.markWorkoutFailed(w.id, delError.message);
        } else {
          await programsRepository.purgeSyncedDeletedWorkout(w.id);
        }
        continue;
      }
      const { error: wError } = await supabase.from('program_workouts').upsert(
        { id: w.id, program_id: w.programId, user_id: w.userId, template_id: w.templateId, week_number: w.weekNumber, day_number: w.dayNumber, sort_order: w.sortOrder },
        { onConflict: 'id' }
      );
      if (wError) {
        await programsRepository.markWorkoutFailed(w.id, wError.message);
      } else {
        await programsRepository.markWorkoutSynced(w.id);
      }
    }
  }
}

export async function pullPrograms(userId: string): Promise<void> {
  const { data, error } = await supabase.from('programs').select('*').eq('user_id', userId);
  if (error || !data) return;
  await programsRepository.reconcileFromServer(data);
}

// ---------------------------------------------------------------------------
// Biometrics — bodyweight, measurements, progress photos (CORE-16)
// ---------------------------------------------------------------------------

export async function pushBodyweightLogs(userId: string): Promise<void> {
  const unsynced = await bodyweightRepository.getUnsynced(userId);
  for (const log of unsynced) {
    if (log.deletedAt) {
      const wasConfirmed = await bodyweightRepository.wasServerConfirmed(log.id);
      if (!wasConfirmed) {
        await bodyweightRepository.purgeLocalOnly(log.id);
        continue;
      }
      const { error } = await supabase.from('timeline_events').update({ deleted_at: log.deletedAt }).eq('id', log.id);
      if (error) {
        await bodyweightRepository.markFailed(log.id, error.message);
      } else {
        await bodyweightRepository.markSynced(log.id);
      }
      continue;
    }

    const wasConfirmed = await bodyweightRepository.wasServerConfirmed(log.id);
    if (!wasConfirmed) {
      const { error: spineError } = await supabase.from('timeline_events').insert({
        id: log.id,
        user_id: log.userId,
        source_module: 'strength',
        event_type: 'bodyweight',
        occurred_at: log.occurredAt,
        local_date: log.localDate,
        event_timezone: log.eventTimezone,
        source: 'manual',
        visibility: 'private',
      });
      // 23505 = unique_violation: a retried push after a prior call that
      // committed but whose response never arrived — treat as already-created.
      if (spineError && spineError.code !== '23505') {
        await bodyweightRepository.markFailed(log.id, spineError.message);
        continue;
      }
      const { error: detailError } = await supabase.from('bodyweight_logs').insert({
        timeline_event_id: log.id,
        user_id: log.userId,
        weight_kg: log.weightKg,
        unit_weight_snapshot: log.unitWeightSnapshot,
        body_fat_pct: log.bodyFatPct,
        source: log.source,
        notes: log.notes,
      });
      if (detailError && detailError.code !== '23505') {
        // CONSENT_REQUIRED_HEALTH surfaces here as a Postgres trigger error
        // (42501) if health consent hasn't synced yet — surfaced distinctly
        // rather than a generic failure, mirroring pushProfileHealth.
        const message = detailError.code === '42501' ? 'Waiting for health consent to sync first.' : detailError.message;
        await bodyweightRepository.markFailed(log.id, message);
        continue;
      }
      await bodyweightRepository.markSynced(log.id);
    } else {
      const { error } = await supabase
        .from('bodyweight_logs')
        .update({ weight_kg: log.weightKg, body_fat_pct: log.bodyFatPct, notes: log.notes })
        .eq('timeline_event_id', log.id);
      if (error) {
        await bodyweightRepository.markFailed(log.id, error.message);
      } else {
        await bodyweightRepository.markSynced(log.id);
      }
    }
  }
}

export async function pullBodyweightLogs(userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('bodyweight_logs')
    .select('*, timeline_events(*)')
    .eq('user_id', userId);
  if (error || !data) return;
  type EmbeddedRow = Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null };
  const rows = (data as EmbeddedRow[])
    .map((row) => {
      const te = Array.isArray(row.timeline_events) ? row.timeline_events[0] : row.timeline_events;
      if (!te) return null;
      return {
        id: row.timeline_event_id,
        user_id: row.user_id,
        occurred_at: te.occurred_at,
        local_date: te.local_date,
        event_timezone: te.event_timezone,
        weight_kg: row.weight_kg,
        unit_weight_snapshot: row.unit_weight_snapshot,
        body_fat_pct: row.body_fat_pct,
        source: row.source,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: te.deleted_at,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  await bodyweightRepository.reconcileFromServer(rows as unknown as ServerBodyweightRow[]);
}

/** Bodyweight/measurements/photos share the identical create+delete shape against the spine — factored to avoid the copy-paste-near-duplicate this would otherwise become. */
async function pushBiometricOccasionTombstoneOrCreate(
  eventType: 'body_measurement' | 'progress_photo',
  occasion: { id: string; userId: string; occurredAt: string; localDate: string; eventTimezone: string; deletedAt: string | null },
  wasConfirmed: boolean,
  // Supabase-js query builders are PromiseLike (thenable) but not real
  // `Promise` instances (no .catch/.finally/Symbol.toStringTag) — typing
  // this as `Promise<...>` fails structural typing even though `await`
  // works on it identically.
  insertDetail: () => PromiseLike<{ error: { code?: string; message: string } | null }>
): Promise<{ error: string | null }> {
  if (occasion.deletedAt) {
    if (!wasConfirmed) return { error: null }; // caller purges locally
    const { error } = await supabase.from('timeline_events').update({ deleted_at: occasion.deletedAt }).eq('id', occasion.id);
    return { error: error?.message ?? null };
  }
  if (wasConfirmed) return { error: null };

  const { error: spineError } = await supabase.from('timeline_events').insert({
    id: occasion.id,
    user_id: occasion.userId,
    source_module: 'strength',
    event_type: eventType,
    occurred_at: occasion.occurredAt,
    local_date: occasion.localDate,
    event_timezone: occasion.eventTimezone,
    source: 'manual',
    visibility: 'private',
  });
  if (spineError && spineError.code !== '23505') return { error: spineError.message };

  const { error: detailError } = await insertDetail();
  if (detailError && detailError.code !== '23505') {
    const message = detailError.code === '42501' ? `Waiting for ${eventType === 'progress_photo' ? 'photo' : 'health'} consent to sync first.` : detailError.message;
    return { error: message };
  }
  return { error: null };
}

export async function pushBodyMeasurements(userId: string): Promise<void> {
  const unsynced = await bodyMeasurementsRepository.getUnsynced(userId);
  for (const occasion of unsynced) {
    const wasConfirmed = await bodyMeasurementsRepository.wasServerConfirmed(occasion.id);
    if (occasion.deletedAt && !wasConfirmed) {
      await bodyMeasurementsRepository.purgeLocalOnly(occasion.id);
      continue;
    }

    const result = await pushBiometricOccasionTombstoneOrCreate('body_measurement', occasion, wasConfirmed, () =>
      supabase.from('body_measurements').insert({ timeline_event_id: occasion.id, user_id: occasion.userId, notes: occasion.notes })
    );
    if (result.error) {
      await bodyMeasurementsRepository.markFailed(occasion.id, result.error);
      continue;
    }

    if (!occasion.deletedAt) {
      for (const v of occasion.values) {
        const { error: valError } = await supabase
          .from('body_measurement_values')
          .upsert(
            { timeline_event_id: occasion.id, user_id: occasion.userId, measurement_kind: v.measurementKind, value: v.value, unit_snapshot: v.unitSnapshot },
            { onConflict: 'timeline_event_id,measurement_kind' }
          );
        // Grant excludes measurement_kind from UPDATE (§8.1 — immutable
        // natural-key column), but a first insert has no conflict yet, and a
        // later edit only ever changes value/unit_snapshot here, both granted.
        if (valError) {
          await bodyMeasurementsRepository.markFailed(occasion.id, valError.message);
        }
      }
    }
    await bodyMeasurementsRepository.markSynced(occasion.id);
  }
}

export async function pullBodyMeasurements(userId: string): Promise<void> {
  // A full authoritative re-read (values are a small child set per occasion,
  // and this table has no independent client-facing edit UI beyond what this
  // device itself wrote — cheap to just overwrite, mirroring personal_records'
  // "server always wins" convention).
  const { data, error } = await supabase.from('body_measurements').select('*, timeline_events(*), body_measurement_values(*)').eq('user_id', userId);
  if (error || !data) return;
  // Reconciliation for this occasion-shaped, less-hot-path table is
  // deliberately simplified to "leave locally-unsynced rows alone, otherwise
  // just re-create/refresh" — reuses bodyMeasurementsRepository.create's
  // upsert-shaped INSERT for both first-write and refresh, since its ON
  // CONFLICT clause already updates every field a pull could change.
  for (const row of data as Record<string, unknown>[]) {
    const te = Array.isArray(row.timeline_events) ? (row.timeline_events as Record<string, unknown>[])[0] : (row.timeline_events as Record<string, unknown> | null);
    if (!te) continue;
    const values = (row.body_measurement_values as { measurement_kind: string; value: number; unit_snapshot: string }[]) ?? [];
    await bodyMeasurementsRepository.create(row.timeline_event_id as string, row.user_id as string, {
      occurredAt: te.occurred_at as string,
      localDate: te.local_date as string,
      eventTimezone: te.event_timezone as string,
      notes: row.notes as string | null,
      values: values.map((v) => ({ measurementKind: v.measurement_kind as never, value: v.value, unitSnapshot: v.unit_snapshot as never })),
    });
    await bodyMeasurementsRepository.markSynced(row.timeline_event_id as string);
  }
}

export async function pushProgressPhotos(userId: string): Promise<void> {
  const unsynced = await progressPhotosRepository.getUnsynced(userId);
  for (const occasion of unsynced) {
    const wasConfirmed = await progressPhotosRepository.wasServerConfirmed(occasion.id);
    if (occasion.deletedAt && !wasConfirmed) {
      await progressPhotosRepository.purgeLocalOnly(occasion.id);
      continue;
    }

    const result = await pushBiometricOccasionTombstoneOrCreate('progress_photo', occasion, wasConfirmed, () =>
      supabase.from('progress_photos').insert({ timeline_event_id: occasion.id, user_id: occasion.userId, notes: occasion.notes })
    );
    if (result.error) {
      await progressPhotosRepository.markFailed(occasion.id, result.error);
      continue;
    }

    if (occasion.deletedAt) {
      await progressPhotosRepository.markSynced(occasion.id);
      continue;
    }

    const pending = await progressPhotosRepository.getPendingImages(occasion.id);
    let allUploaded = true;
    for (const image of pending) {
      if (image.uploadStatus === 'uploaded') continue;
      if (!image.localUri) {
        allUploaded = false;
        continue;
      }
      // Upload-then-metadata ordering (§5/§10): bytes land in Storage FIRST;
      // the metadata row is written only on a confirmed upload — never
      // report "saved" on a partial upload.
      const uploadResult = await uploadProgressPhoto(occasion.userId, occasion.id, image.pose, image.localUri);
      if (!uploadResult.ok) {
        await progressPhotosRepository.markImageFailed(image.id);
        allUploaded = false;
        continue;
      }
      await progressPhotosRepository.markImageUploaded(image.id, uploadResult.objectPath, uploadResult.checksum);
      const { error: imgError } = await supabase.from('progress_photo_images').insert({
        id: image.id,
        timeline_event_id: occasion.id,
        user_id: occasion.userId,
        pose: image.pose,
        object_path: uploadResult.objectPath,
        checksum: uploadResult.checksum,
      });
      if (imgError && imgError.code !== '23505') {
        allUploaded = false;
        await progressPhotosRepository.markFailed(occasion.id, imgError.message);
      }
    }

    if (allUploaded) {
      await progressPhotosRepository.markSynced(occasion.id);
    }
  }
}

export async function pullProgressPhotos(userId: string): Promise<void> {
  const { data, error } = await supabase.from('progress_photos').select('*, timeline_events(*)').eq('user_id', userId);
  if (error || !data) return;
  // Photo metadata (never the bytes) is refreshed the same "server wins,
  // this device's own unsynced writes are left alone" way as body measurements.
  for (const row of data as Record<string, unknown>[]) {
    const existing = await progressPhotosRepository.getById(row.timeline_event_id as string);
    if (existing && existing.syncStatus !== 'synced') continue;
    const te = Array.isArray(row.timeline_events) ? (row.timeline_events as Record<string, unknown>[])[0] : (row.timeline_events as Record<string, unknown> | null);
    if (!te) continue;
    if (!existing) {
      await progressPhotosRepository.create(row.timeline_event_id as string, row.user_id as string, {
        occurredAt: te.occurred_at as string,
        localDate: te.local_date as string,
        eventTimezone: te.event_timezone as string,
        notes: row.notes as string | null,
      });
      await progressPhotosRepository.markSynced(row.timeline_event_id as string);
    }
  }
}
