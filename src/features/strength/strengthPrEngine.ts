/**
 * Client-side strength PR comparison engine — the on-device counterpart to
 * `save_workout_session_v1`'s PR detection (docs/api/save-workout-session-v1.md
 * §2.6), so the LiftStack/PrBadge can celebrate a set instantly at
 * completion, offline (design doc CORE-12 "The completion moment" +
 * implementation-coordination note 8: "optimistic-then-reconciled").
 *
 * Deliberately replicates the RPC's batching fix (§2.6 — "one candidate per
 * (exercise_ref, metric) per call, not one per set"): evaluating live,
 * uncommitted in-session sets one-by-one as they complete would double-count
 * an ascending/pyramid session (e.g. squat 100kg then 105kg, both working)
 * as two sequential "beats" instead of one, exactly the bug the RPC's own
 * migration header documents fixing server-side. `bestCandidatesForExercise`
 * mirrors that by taking the single best in-session value per metric before
 * comparing to the cache.
 *
 * Pure module — no DB/network imports — unit-testable without a SQLite mock.
 */
import type { ExerciseFieldFlags, StrengthPrMetric, WorkoutSetType } from '../../db/types';

const EPLEY_REP_DIVISOR = 30;

/** Epley 1RM estimate — architecture §4.2/§12 item 3, confirmed formula. `null` when weight or reps are missing/non-positive (nothing to estimate). */
export function estimateEpley1Rm(weightKg: number | null, reps: number | null): number | null {
  if (weightKg == null || reps == null || weightKg < 0 || reps <= 0) return null;
  return weightKg * (1 + reps / EPLEY_REP_DIVISOR);
}

/** Every PR metric that applies to this movement's field-set metadata (architecture §4.1). */
export function candidateMetricsForExercise(flags: Pick<ExerciseFieldFlags, 'isWeighted' | 'isBodyweight'>): StrengthPrMetric[] {
  const metrics: StrengthPrMetric[] = [];
  if (flags.isWeighted) metrics.push('heaviest_weight', 'estimated_1rm', 'best_set_volume');
  if (flags.isBodyweight) metrics.push('max_reps');
  return metrics;
}

export type SetCandidateSource = {
  sourceSetLogId: string;
  reps: number | null;
  weightKg: number | null;
  estimated1rmKg: number | null;
  setType: WorkoutSetType;
  isCompleted: boolean;
};

/** Warmup/failed/incomplete sets never contribute to PR detection (§4.1, mirrors LiftStack's own "working sets only" rule). */
function isPrEligible(set: SetCandidateSource): boolean {
  return set.setType === 'working' && set.isCompleted;
}

export function extractCandidateValue(metric: StrengthPrMetric, set: SetCandidateSource): number | null {
  switch (metric) {
    case 'heaviest_weight':
      return set.weightKg;
    case 'estimated_1rm':
      return set.estimated1rmKg;
    case 'best_set_volume':
      return set.reps != null && set.weightKg != null ? set.reps * set.weightKg : null;
    case 'max_reps':
      return set.reps;
    default:
      return null;
  }
}

export type CachedStrengthRecord = { value: number };

export type StrengthPrEvaluation = {
  exerciseId: string | null;
  customExerciseId: string | null;
  metric: StrengthPrMetric;
  value: number;
  previousValue: number | null;
  isFirstEver: boolean;
  sourceSetLogId: string;
  unitSnapshot: string | null;
};

/**
 * Batched evaluation for one exercise's sets within a single session save
 * (mirrors RPC §2.6): picks the single best PR-eligible candidate per metric
 * across all the given sets, then compares that one candidate against the
 * cache. Strictly-greater wins (ties are not a new PR, matching the server).
 */
export function evaluateExerciseCandidates(
  exerciseId: string | null,
  customExerciseId: string | null,
  flags: Pick<ExerciseFieldFlags, 'isWeighted' | 'isBodyweight'>,
  sets: SetCandidateSource[],
  cache: ReadonlyMap<StrengthPrMetric, CachedStrengthRecord>,
  unitSnapshot: string | null
): StrengthPrEvaluation[] {
  const eligible = sets.filter(isPrEligible);
  const results: StrengthPrEvaluation[] = [];

  for (const metric of candidateMetricsForExercise(flags)) {
    let best: { value: number; sourceSetLogId: string } | null = null;
    for (const set of eligible) {
      const value = extractCandidateValue(metric, set);
      if (value == null) continue;
      if (!best || value > best.value) best = { value, sourceSetLogId: set.sourceSetLogId };
    }
    if (!best) continue;

    const existing = cache.get(metric);
    if (!existing) {
      results.push({ exerciseId, customExerciseId, metric, value: best.value, previousValue: null, isFirstEver: true, sourceSetLogId: best.sourceSetLogId, unitSnapshot });
    } else if (best.value > existing.value) {
      results.push({ exerciseId, customExerciseId, metric, value: best.value, previousValue: existing.value, isFirstEver: false, sourceSetLogId: best.sourceSetLogId, unitSnapshot });
    }
  }
  return results;
}

/** Reconciliation diff — mirrors `diffAchievements` in `prEngine.ts` exactly, scoped to strength metrics. */
export function diffStrengthAchievements(
  optimisticMetrics: readonly StrengthPrMetric[],
  serverMetrics: readonly StrengthPrMetric[]
): { confirmed: StrengthPrMetric[]; retracted: StrengthPrMetric[] } {
  const serverSet = new Set(serverMetrics);
  return {
    confirmed: optimisticMetrics.filter((m) => serverSet.has(m)),
    retracted: optimisticMetrics.filter((m) => !serverSet.has(m)),
  };
}
