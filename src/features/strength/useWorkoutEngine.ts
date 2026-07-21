import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { AppState } from 'react-native';

import { generateUuidV4 } from '../../lib/uuid';
import { workoutSessionsRepository, type SetWriteFields } from '../../db/repositories/workoutSessionsRepository';
import { strengthRecordsRepository, exerciseRefKey } from '../../db/repositories/strengthRecordsRepository';
import { strengthAchievementsRepository } from '../../db/repositories/strengthAchievementsRepository';
import { exercisesRepository, exerciseFieldFlags } from '../../db/repositories/exercisesRepository';
import { customExercisesRepository } from '../../db/repositories/customExercisesRepository';
import { runSync } from '../../sync/syncEngine';
import {
  cancelRestDoneNotification,
  ensureRestTimerNotificationPermission,
  scheduleRestDoneNotification,
} from '../../lib/restTimerNotifications';
import { estimateEpley1Rm, evaluateExerciseCandidates, type StrengthPrEvaluation } from './strengthPrEngine';
import type {
  ExerciseFieldFlags,
  LocalWorkoutSession,
  LocalWorkoutSet,
  MuscleGroup,
  UnitWeightSnapshot,
  WorkoutSetType,
} from '../../db/types';

const REST_ADJUST_SECONDS = 15;
const REST_ENDING_THRESHOLD_SECONDS = 10;
const UI_TICK_MS = 1000;

export type ExercisePick = {
  exerciseId: string | null;
  customExerciseId: string | null;
  name: string;
  primaryMuscle: MuscleGroup | null;
  fieldFlags: ExerciseFieldFlags;
  /** Optional plan seed — from "Start workout from a template" (design doc CORE-14). */
  targetSets?: number | null;
  targetRestSeconds?: number | null;
};

export type ExerciseBlockState = {
  exerciseOrder: number;
  exerciseId: string | null;
  customExerciseId: string | null;
  exerciseNameSnapshot: string;
  primaryMuscleSnapshot: MuscleGroup | null;
  fieldFlags: ExerciseFieldFlags;
  sets: LocalWorkoutSet[];
  previousSets: LocalWorkoutSet[];
};

export type FinishDraft = {
  durationSeconds: number;
  totalVolumeKg: number;
  totalSets: number;
  prEvaluations: StrengthPrEvaluation[];
  exerciseNamesById: Map<string, string>;
};

export type RestTimerState = {
  running: boolean;
  remainingSeconds: number;
  plannedSeconds: number;
  ending: boolean;
  done: boolean;
};

const IDLE_REST_STATE: RestTimerState = { running: false, remainingSeconds: 0, plannedSeconds: 0, ending: false, done: false };

function nextExerciseOrder(blocks: ExerciseBlockState[]): number {
  return blocks.length === 0 ? 0 : Math.max(...blocks.map((b) => b.exerciseOrder)) + 1;
}

/** Pure mapping, module-scope (no closure over hook state) so its reference is always stable inside `useCallback` bodies below — never itself a dependency-array concern. */
function toWriteFields(set: LocalWorkoutSet): SetWriteFields {
  return {
    exerciseId: set.exerciseId,
    customExerciseId: set.customExerciseId,
    exerciseNameSnapshot: set.exerciseNameSnapshot,
    primaryMuscleSnapshot: set.primaryMuscleSnapshot,
    exerciseOrder: set.exerciseOrder,
    setNumber: set.setNumber,
    setType: set.setType,
    reps: set.reps,
    weightKg: set.weightKg,
    unitWeightSnapshot: set.unitWeightSnapshot,
    isBodyweight: set.isBodyweight,
    durationSeconds: set.durationSeconds,
    distanceM: set.distanceM,
    rpe: set.rpe,
    restSecondsPlanned: set.restSecondsPlanned,
    restSecondsActual: set.restSecondsActual,
    isCompleted: set.isCompleted,
    estimated1rmKg: set.estimated1rmKg,
    notes: set.notes,
  };
}

/**
 * CORE-12 active-workout-logging engine — the Module C analog of
 * `useRecordingEngine.ts` (same "in-progress local domain state, durable
 * across a crash, never blocked on network at Finish" shape). Fields sync
 * via `src/sync/workoutSync.ts` on the normal opportunistic triggers.
 */
export function useWorkoutEngine(params: { userId: string; unitWeight: UnitWeightSnapshot }) {
  const { userId, unitWeight } = params;

  const [loading, setLoading] = useState(true);
  const [crashRecoverySession, setCrashRecoverySession] = useState<LocalWorkoutSession | null>(null);
  const [session, setSession] = useState<LocalWorkoutSession | null>(null);
  const [sets, setSets] = useState<LocalWorkoutSet[]>([]);
  const [previousSetsByRef, setPreviousSetsByRef] = useState<Map<string, LocalWorkoutSet[]>>(new Map());
  const [fieldFlagsByRef, setFieldFlagsByRef] = useState<Map<string, ExerciseFieldFlags>>(new Map());
  const [restTimer, setRestTimer] = useState<RestTimerState>(IDLE_REST_STATE);
  const [autoRestEnabled, setAutoRestEnabled] = useState(true);
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);

  const restEndAtRef = useRef<number | null>(null);
  const restSetIdRef = useRef<string | null>(null);
  const restStartedAtRef = useRef<number | null>(null);
  const sessionStartRef = useRef<number | null>(null);

  const refreshSets = useCallback(async (sessionId: string) => {
    const rows = await workoutSessionsRepository.getSetsForSession(sessionId);
    setSets(rows);
  }, []);

  /** Writes `rest_seconds_actual` onto the just-rested set once the timer stops (design doc §9.5), whether it ran to zero or was skipped early. Declared early (before the effects below reference it) — TS flags a `const` referenced-before-declaration even inside a deferred closure. */
  const persistRestActual = useCallback(
    async (setId: string, actualSeconds: number): Promise<void> => {
      const set = await workoutSessionsRepository.getSet(setId);
      if (!set || !session) return;
      await workoutSessionsRepository.upsertSet(set.id, set.timelineEventId, session.userId, toWriteFields({ ...set, restSecondsActual: actualSeconds }));
      await refreshSets(session.id);
    },
    [session, refreshSets]
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const active = await workoutSessionsRepository.getInProgressForUser(userId);
      if (!mounted) return;
      if (active) setCrashRecoverySession(active);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => setTick((t) => t + 1), UI_TICK_MS);
    return () => clearInterval(interval);
  }, [session]);

  // Rest timer countdown — pure client-side UI state (§9.5), never network.
  useEffect(() => {
    if (!restTimer.running) return;
    const interval = setInterval(() => {
      const endAt = restEndAtRef.current;
      if (endAt == null) return;
      const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
      setRestTimer((prev) => ({
        ...prev,
        remainingSeconds: remaining,
        ending: remaining > 0 && remaining <= REST_ENDING_THRESHOLD_SECONDS,
        done: remaining === 0,
      }));
      if (remaining === 0) {
        // Persist rest_seconds_actual on the set that triggered this rest,
        // then stop — the notification (if backgrounded) already fired via
        // the OS-scheduled trigger, independent of this in-app tick.
        const setId = restSetIdRef.current;
        const startedAt = restStartedAtRef.current;
        if (setId && startedAt) {
          const actual = Math.round((Date.now() - startedAt) / 1000);
          void persistRestActual(setId, actual);
        }
        clearInterval(interval);
      }
    }, UI_TICK_MS);
    return () => clearInterval(interval);
  }, [restTimer.running, persistRestActual]);

  // §CORE-12 "Rest-timer edge": if the app was backgrounded past a rest's
  // end, on return the timer must show "Rest done," not silently keep
  // counting a stale negative — recompute immediately on foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const endAt = restEndAtRef.current;
      if (endAt == null) return;
      const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
      setRestTimer((prev) => (prev.running ? { ...prev, remainingSeconds: remaining, ending: remaining <= REST_ENDING_THRESHOLD_SECONDS && remaining > 0, done: remaining === 0 } : prev));
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (session) void activateKeepAwakeAsync('milelift-workout');
    else void deactivateKeepAwake('milelift-workout');
    return () => void deactivateKeepAwake('milelift-workout');
  }, [session]);

  // Resolves each distinct exercise's real field-set metadata (is_weighted /
  // is_bodyweight / is_time_based / is_distance_based) from the offline-
  // cached library/custom-exercise repositories, rather than guessing from
  // which set columns happen to be filled in yet — correct across both the
  // live add-exercise path and crash-recovery/resume (where this hook never
  // re-runs the original `addExercise` call, so anything derived only at
  // add-time would be lost). Drives PR-metric eligibility (§4.1) and the
  // SetRow field set (design doc §A).
  useEffect(() => {
    const distinctRefs = new Map<string, { exerciseId: string | null; customExerciseId: string | null }>();
    for (const s of sets) {
      if (s.deletedAt) continue;
      const ref = exerciseRefKey(s.exerciseId, s.customExerciseId);
      if (!fieldFlagsByRef.has(ref) && !distinctRefs.has(ref)) distinctRefs.set(ref, { exerciseId: s.exerciseId, customExerciseId: s.customExerciseId });
    }
    if (distinctRefs.size === 0) return;

    let cancelled = false;
    (async () => {
      const resolved = new Map<string, ExerciseFieldFlags>();
      for (const [ref, { exerciseId, customExerciseId }] of distinctRefs) {
        if (exerciseId) {
          const ex = await exercisesRepository.getById(exerciseId);
          if (ex) resolved.set(ref, exerciseFieldFlags(ex));
        } else if (customExerciseId) {
          const ex = await customExercisesRepository.getById(customExerciseId);
          if (ex) resolved.set(ref, { isWeighted: ex.isWeighted, isBodyweight: ex.isBodyweight, isTimeBased: ex.isTimeBased, isDistanceBased: ex.isDistanceBased });
        }
      }
      if (!cancelled && resolved.size > 0) {
        setFieldFlagsByRef((prev) => {
          const next = new Map(prev);
          for (const [ref, flags] of resolved) next.set(ref, flags);
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sets, fieldFlagsByRef]);

  const start = useCallback(
    async (opts: { title?: string | null; sourceTemplateId?: string | null; templateNameSnapshot?: string | null; templateExercises?: ExercisePick[] } = {}) => {
      const id = generateUuidV4();
      const now = new Date();
      const created = await workoutSessionsRepository.startInProgress(id, userId, {
        title: opts.title ?? null,
        occurredAt: now.toISOString(),
        localDate: localDateString(now),
        eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        sourceTemplateId: opts.sourceTemplateId ?? null,
        templateNameSnapshot: opts.templateNameSnapshot ?? null,
      });
      setSession(created);
      setSets([]);
      sessionStartRef.current = Date.now();

      if (opts.templateExercises && opts.templateExercises.length > 0) {
        let order = 0;
        for (const pick of opts.templateExercises) {
          const targetSets = pick.targetSets ?? 1;
          for (let i = 0; i < targetSets; i++) {
            await workoutSessionsRepository.upsertSet(generateUuidV4(), id, userId, {
              exerciseId: pick.exerciseId,
              customExerciseId: pick.customExerciseId,
              exerciseNameSnapshot: pick.name,
              primaryMuscleSnapshot: pick.primaryMuscle,
              exerciseOrder: order,
              setNumber: i + 1,
              setType: 'working',
              reps: null,
              weightKg: null,
              unitWeightSnapshot: unitWeight,
              isBodyweight: pick.fieldFlags.isBodyweight,
              durationSeconds: null,
              distanceM: null,
              rpe: null,
              restSecondsPlanned: pick.targetRestSeconds ?? null,
              restSecondsActual: null,
              isCompleted: false,
              estimated1rmKg: null,
              notes: null,
            });
          }
          order += 1;
        }
        await refreshSets(id);
      }
      return created;
    },
    [userId, unitWeight, refreshSets]
  );

  const resumeCrashRecovery = useCallback(async () => {
    if (!crashRecoverySession) return;
    setSession(crashRecoverySession);
    await refreshSets(crashRecoverySession.id);
    sessionStartRef.current = Date.now() - Math.max(0, Date.now() - new Date(crashRecoverySession.occurredAt).getTime());
    setCrashRecoverySession(null);
  }, [crashRecoverySession, refreshSets]);

  const discardCrashRecovery = useCallback(async () => {
    if (!crashRecoverySession) return;
    await workoutSessionsRepository.discardInProgress(crashRecoverySession.id);
    setCrashRecoverySession(null);
  }, [crashRecoverySession]);

  /**
   * Session-detail "Edit" (design doc CORE-15): loads an already-FINISHED
   * session's sets back into this screen for editing. Deliberately does NOT
   * touch `is_finished`/`sync_status` on load — `confirmFinish` re-running
   * `workoutSessionsRepository.finish` on an already-finished session is
   * exactly the RPC's own "also used for edits and incremental appends"
   * path (RPC §2): any set the user changes gets re-marked `dirty` by
   * `upsertSet` as usual, and the session flips back to `pending` so the
   * edit re-syncs idempotently, same as a fresh finish.
   */
  const loadForEdit = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const existing = await workoutSessionsRepository.getSession(sessionId);
      if (!existing) return false;
      setSession(existing);
      await refreshSets(sessionId);
      sessionStartRef.current = Date.now() - existing.durationSeconds * 1000;
      return true;
    },
    [refreshSets]
  );

  const exerciseBlocks = useMemo<ExerciseBlockState[]>(() => {
    const byOrder = new Map<number, LocalWorkoutSet[]>();
    for (const s of sets) {
      if (s.deletedAt) continue;
      const list = byOrder.get(s.exerciseOrder) ?? [];
      list.push(s);
      byOrder.set(s.exerciseOrder, list);
    }
    return Array.from(byOrder.entries())
      .sort(([a], [b]) => a - b)
      .map(([exerciseOrder, blockSets]) => {
        const first = blockSets[0]!;
        const ref = exerciseRefKey(first.exerciseId, first.customExerciseId);
        // Fallback heuristic (only used for the brief window before the
        // resolver effect above completes its lookup) — inferred from which
        // columns are actually populated so far, since a true "unknown" flag
        // set would otherwise wrongly exclude a just-added exercise from any
        // PR evaluation at all.
        const fallback: ExerciseFieldFlags = {
          isWeighted: first.weightKg != null || blockSets.some((s) => s.weightKg != null),
          isBodyweight: first.isBodyweight,
          isTimeBased: blockSets.some((s) => s.durationSeconds != null),
          isDistanceBased: blockSets.some((s) => s.distanceM != null),
        };
        return {
          exerciseOrder,
          exerciseId: first.exerciseId,
          customExerciseId: first.customExerciseId,
          exerciseNameSnapshot: first.exerciseNameSnapshot,
          primaryMuscleSnapshot: first.primaryMuscleSnapshot,
          fieldFlags: fieldFlagsByRef.get(ref) ?? fallback,
          sets: blockSets.sort((a, b) => a.setNumber - b.setNumber),
          previousSets: previousSetsByRef.get(ref) ?? [],
        };
      });
  }, [sets, previousSetsByRef, fieldFlagsByRef]);

  const addExercise = useCallback(
    async (pick: ExercisePick) => {
      if (!session) return;
      const order = nextExerciseOrder(exerciseBlocks);
      const setId = generateUuidV4();
      await workoutSessionsRepository.upsertSet(setId, session.id, session.userId, {
        exerciseId: pick.exerciseId,
        customExerciseId: pick.customExerciseId,
        exerciseNameSnapshot: pick.name,
        primaryMuscleSnapshot: pick.primaryMuscle,
        exerciseOrder: order,
        setNumber: 1,
        setType: 'working',
        reps: null,
        weightKg: null,
        unitWeightSnapshot: unitWeight,
        isBodyweight: pick.fieldFlags.isBodyweight,
        durationSeconds: null,
        distanceM: null,
        rpe: null,
        restSecondsPlanned: pick.targetRestSeconds ?? null,
        restSecondsActual: null,
        isCompleted: false,
        estimated1rmKg: null,
        notes: null,
      });

      const ref = exerciseRefKey(pick.exerciseId, pick.customExerciseId);
      const previous = await workoutSessionsRepository.getPreviousSetsForExercise(session.userId, pick.exerciseId, pick.customExerciseId, session.id);
      setPreviousSetsByRef((prev) => new Map(prev).set(ref, previous));

      await refreshSets(session.id);
    },
    [session, exerciseBlocks, unitWeight, refreshSets]
  );

  /** Add set row — duplicates the last set's values as the default (design doc: "logging speed"). */
  const addSet = useCallback(
    async (exerciseOrder: number, setType: WorkoutSetType = 'working') => {
      if (!session) return;
      const block = exerciseBlocks.find((b) => b.exerciseOrder === exerciseOrder);
      if (!block) return;
      const last = block.sets[block.sets.length - 1];
      const setId = generateUuidV4();
      await workoutSessionsRepository.upsertSet(setId, session.id, session.userId, {
        exerciseId: block.exerciseId,
        customExerciseId: block.customExerciseId,
        exerciseNameSnapshot: block.exerciseNameSnapshot,
        primaryMuscleSnapshot: block.primaryMuscleSnapshot,
        exerciseOrder,
        setNumber: block.sets.length + 1,
        setType,
        reps: last?.reps ?? null,
        weightKg: last?.weightKg ?? null,
        unitWeightSnapshot: last?.unitWeightSnapshot ?? unitWeight,
        isBodyweight: last?.isBodyweight ?? block.fieldFlags.isBodyweight,
        durationSeconds: last?.durationSeconds ?? null,
        distanceM: last?.distanceM ?? null,
        rpe: null,
        restSecondsPlanned: last?.restSecondsPlanned ?? null,
        restSecondsActual: null,
        isCompleted: false,
        estimated1rmKg: null,
        notes: null,
      });
      await refreshSets(session.id);
    },
    [session, exerciseBlocks, unitWeight, refreshSets]
  );

  const updateSet = useCallback(
    async (setId: string, partial: Partial<Pick<LocalWorkoutSet, 'reps' | 'weightKg' | 'durationSeconds' | 'distanceM' | 'rpe' | 'setType' | 'notes' | 'restSecondsPlanned'>>) => {
      if (!session) return;
      const current = sets.find((s) => s.id === setId);
      if (!current) return;
      const updated = { ...current, ...partial };
      await workoutSessionsRepository.upsertSet(setId, session.id, session.userId, toWriteFields(updated));
      await refreshSets(session.id);
    },
    [session, sets, refreshSets]
  );

  const startRestTimer = useCallback(async (setId: string, plannedSeconds: number) => {
    restSetIdRef.current = setId;
    restStartedAtRef.current = Date.now();
    restEndAtRef.current = Date.now() + plannedSeconds * 1000;
    setRestTimer({ running: true, remainingSeconds: plannedSeconds, plannedSeconds, ending: plannedSeconds <= REST_ENDING_THRESHOLD_SECONDS, done: false });
    await ensureRestTimerNotificationPermission();
    await scheduleRestDoneNotification(plannedSeconds);
  }, []);

  const adjustRestTimer = useCallback((deltaSeconds: number) => {
    if (restEndAtRef.current == null) return;
    restEndAtRef.current += deltaSeconds * 1000;
    setRestTimer((prev) => {
      const remaining = Math.max(0, Math.round((restEndAtRef.current! - Date.now()) / 1000));
      return { ...prev, remainingSeconds: remaining, ending: remaining > 0 && remaining <= REST_ENDING_THRESHOLD_SECONDS, done: remaining === 0 };
    });
    void scheduleRestDoneNotification(Math.max(1, Math.round((restEndAtRef.current - Date.now()) / 1000)));
  }, []);

  const skipRestTimer = useCallback(async () => {
    const setId = restSetIdRef.current;
    const startedAt = restStartedAtRef.current;
    if (setId && startedAt) {
      await persistRestActual(setId, Math.round((Date.now() - startedAt) / 1000));
    }
    restEndAtRef.current = null;
    restSetIdRef.current = null;
    restStartedAtRef.current = null;
    setRestTimer(IDLE_REST_STATE);
    await cancelRestDoneNotification();
  }, [persistRestActual]);

  const dismissRestTimer = useCallback(() => {
    restEndAtRef.current = null;
    restSetIdRef.current = null;
    restStartedAtRef.current = null;
    setRestTimer(IDLE_REST_STATE);
  }, []);

  /** The completion moment (design doc CORE-12) — locks the set, stacks the LiftStack segment, evaluates the optimistic PR. */
  const completeSet = useCallback(
    async (setId: string): Promise<{ prEvaluations: StrengthPrEvaluation[] }> => {
      if (!session) return { prEvaluations: [] };
      const current = sets.find((s) => s.id === setId);
      if (!current) return { prEvaluations: [] };

      const estimated1rmKg = estimateEpley1Rm(current.weightKg, current.reps);
      const completed: LocalWorkoutSet = { ...current, isCompleted: true, estimated1rmKg };
      await workoutSessionsRepository.upsertSet(setId, session.id, session.userId, toWriteFields(completed));
      await refreshSets(session.id);

      let prEvaluations: StrengthPrEvaluation[] = [];
      if (completed.setType === 'working') {
        const block = exerciseBlocks.find((b) => b.exerciseOrder === current.exerciseOrder);
        const flags: ExerciseFieldFlags = block?.fieldFlags ?? { isWeighted: current.weightKg != null, isBodyweight: current.isBodyweight, isTimeBased: false, isDistanceBased: false };
        const allSetsThisExercise = (await workoutSessionsRepository.getSetsForSession(session.id)).filter(
          (s) => s.exerciseId === current.exerciseId && s.customExerciseId === current.customExerciseId && s.exerciseOrder === current.exerciseOrder
        );
        const cache = await strengthRecordsRepository.getForExercise(session.userId, current.exerciseId, current.customExerciseId);
        prEvaluations = evaluateExerciseCandidates(
          current.exerciseId,
          current.customExerciseId,
          flags,
          allSetsThisExercise.map((s) => ({
            sourceSetLogId: s.id,
            reps: s.reps,
            weightKg: s.weightKg,
            estimated1rmKg: s.id === setId ? estimated1rmKg : s.estimated1rmKg,
            setType: s.setType,
            isCompleted: s.id === setId ? true : s.isCompleted,
          })),
          cache,
          current.unitWeightSnapshot
        );
        if (prEvaluations.length > 0) {
          await strengthRecordsRepository.applyOptimistic(session.userId, session.id, session.occurredAt, prEvaluations);
          await strengthAchievementsRepository.applyOptimistic(session.id, session.userId, prEvaluations);
        }
      }

      const restTarget = current.restSecondsPlanned;
      if (autoRestEnabled && restTarget != null && restTarget > 0) {
        await startRestTimer(setId, restTarget);
      }

      return { prEvaluations };
    },
    [session, sets, exerciseBlocks, autoRestEnabled, refreshSets, startRestTimer]
  );

  const uncompleteSet = useCallback(
    async (setId: string) => {
      if (!session) return;
      const current = sets.find((s) => s.id === setId);
      if (!current) return;
      await workoutSessionsRepository.upsertSet(setId, session.id, session.userId, toWriteFields({ ...current, isCompleted: false }));
      await refreshSets(session.id);
    },
    [session, sets, refreshSets]
  );

  const removeSet = useCallback(
    async (setId: string) => {
      await workoutSessionsRepository.removeSet(setId);
      if (session) await refreshSets(session.id);
    },
    [session, refreshSets]
  );

  /** Removing an exercise with completed sets tombstones those sets in the next save payload — never dropped by omission (design doc CORE-12 / RPC §2.1). */
  const removeExercise = useCallback(
    async (exerciseOrder: number) => {
      if (!session) return;
      const block = exerciseBlocks.find((b) => b.exerciseOrder === exerciseOrder);
      if (!block) return;
      for (const s of block.sets) {
        await workoutSessionsRepository.removeSet(s.id);
      }
      await refreshSets(session.id);
    },
    [session, exerciseBlocks, refreshSets]
  );

  const moveExercise = useCallback(
    async (exerciseOrder: number, direction: 'up' | 'down') => {
      if (!session) return;
      const sorted = [...exerciseBlocks].sort((a, b) => a.exerciseOrder - b.exerciseOrder);
      const index = sorted.findIndex((b) => b.exerciseOrder === exerciseOrder);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= sorted.length) return;

      const a = sorted[index]!;
      const b = sorted[targetIndex]!;
      for (const s of a.sets) {
        await workoutSessionsRepository.upsertSet(s.id, session.id, session.userId, toWriteFields({ ...s, exerciseOrder: b.exerciseOrder }));
      }
      for (const s of b.sets) {
        await workoutSessionsRepository.upsertSet(s.id, session.id, session.userId, toWriteFields({ ...s, exerciseOrder: a.exerciseOrder }));
      }
      await refreshSets(session.id);
    },
    [session, exerciseBlocks, refreshSets]
  );

  const updateSessionMeta = useCallback(
    async (fields: { title?: string | null; notes?: string | null; sessionRpe?: number | null }) => {
      if (!session) return;
      await workoutSessionsRepository.updateMeta(session.id, fields);
      setSession(await workoutSessionsRepository.getSession(session.id));
    },
    [session]
  );

  const prepareFinish = useCallback(async (): Promise<FinishDraft | null> => {
    if (!session) return null;
    const workingSets = sets.filter((s) => !s.deletedAt && s.setType === 'working' && s.isCompleted);
    const totalVolumeKg = workingSets.reduce((sum, s) => sum + (s.reps ?? 0) * (s.weightKg ?? 0), 0);

    // Aggregate PR preview across every exercise in the session — reuses the
    // exact per-exercise batching evaluateExerciseCandidates already applies
    // live at each completion, so the Save sheet's PrCallout can never
    // diverge from what completeSet already celebrated.
    const byExercise = new Map<string, { exerciseId: string | null; customExerciseId: string | null; flags: ExerciseFieldFlags; sets: LocalWorkoutSet[] }>();
    for (const block of exerciseBlocks) {
      const ref = exerciseRefKey(block.exerciseId, block.customExerciseId);
      const existing = byExercise.get(ref);
      if (existing) existing.sets.push(...block.sets);
      else byExercise.set(ref, { exerciseId: block.exerciseId, customExerciseId: block.customExerciseId, flags: block.fieldFlags, sets: [...block.sets] });
    }

    const prEvaluations: StrengthPrEvaluation[] = [];
    const exerciseNamesById = new Map<string, string>();
    for (const block of exerciseBlocks) exerciseNamesById.set(exerciseRefKey(block.exerciseId, block.customExerciseId), block.exerciseNameSnapshot);

    for (const [, group] of byExercise) {
      const cache = await strengthRecordsRepository.getForExercise(session.userId, group.exerciseId, group.customExerciseId);
      const evaluations = evaluateExerciseCandidates(
        group.exerciseId,
        group.customExerciseId,
        group.flags,
        group.sets.map((s) => ({ sourceSetLogId: s.id, reps: s.reps, weightKg: s.weightKg, estimated1rmKg: s.estimated1rmKg, setType: s.setType, isCompleted: s.isCompleted })),
        cache,
        group.sets[0]?.unitWeightSnapshot ?? unitWeight
      );
      prEvaluations.push(...evaluations);
    }

    const durationSeconds = sessionStartRef.current ? Math.round((Date.now() - sessionStartRef.current) / 1000) : session.durationSeconds;

    return { durationSeconds, totalVolumeKg, totalSets: workingSets.length, prEvaluations, exerciseNamesById };
  }, [session, sets, exerciseBlocks, unitWeight]);

  const confirmFinish = useCallback(
    async (draft: FinishDraft, title: string, notes: string | null, sessionRpe: number | null): Promise<string> => {
      if (!session) throw new Error('No active workout session to finish.');
      setSaving(true);
      try {
        await workoutSessionsRepository.updateMeta(session.id, { title, notes });
        await workoutSessionsRepository.finish(session.id, draft.durationSeconds, sessionRpe);
        setSession(null);
        setSets([]);
        void runSync('post-write');
        return session.id;
      } finally {
        setSaving(false);
      }
    },
    [session]
  );

  const discard = useCallback(async () => {
    if (!session) return;
    await workoutSessionsRepository.discardInProgress(session.id);
    setSession(null);
    setSets([]);
  }, [session]);

  return {
    loading,
    crashRecoverySession,
    resumeCrashRecovery,
    discardCrashRecovery,

    session,
    exerciseBlocks,
    autoRestEnabled,
    setAutoRestEnabled,
    restTimer,
    startRestTimer,
    adjustRestTimer,
    skipRestTimer,
    dismissRestTimer,

    start,
    loadForEdit,
    addExercise,
    addSet,
    updateSet,
    completeSet,
    uncompleteSet,
    removeSet,
    removeExercise,
    moveExercise,
    updateSessionMeta,
    prepareFinish,
    confirmFinish,
    discard,
    saving,
    tick,
  };
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export { REST_ADJUST_SECONDS };
