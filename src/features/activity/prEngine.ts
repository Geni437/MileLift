/**
 * Personal-record comparison engine — the SAME O(#metrics) point-comparison
 * logic `save_activity_v1` runs server-side (docs/api/save-activity-v1.md
 * §2.6), reimplemented client-side so the Save sheet can celebrate a PR
 * INSTANTLY on an offline finish, per docs/design/screens-phase-1.md CORE-04
 * "Offline PR detection" judgment call:
 *
 *   "at finish, compute PRs optimistically on-device against the local
 *   personal_records cache ... so the celebration is instant and works
 *   offline. On sync, reconcile with the RPC's authoritative array: if the
 *   server disagrees ... quietly correct the badge — never a second
 *   celebratory interruption, and never a badge that contradicts the server
 *   long-term."
 *
 * Pure module — no DB/network imports — so the comparison logic itself is
 * unit-testable without a SQLite or Supabase mock (test-strategy).
 */
import type { PrMetric } from '../../db/types';

export type ActivityTypeMetricFlags = { isDistanceBased: boolean; tracksElevation: boolean };

/** Every metric that applies to a save/edit of this activity type, per architecture §4.1. */
export function candidateMetricsForType(flags: ActivityTypeMetricFlags): PrMetric[] {
  const metrics: PrMetric[] = ['longest_duration'];
  if (flags.isDistanceBased) {
    metrics.push('longest_distance', 'fastest_avg_pace');
  }
  if (flags.tracksElevation) {
    metrics.push('most_elevation_gain');
  }
  return metrics;
}

export type ActivityMetricSource = {
  durationSeconds: number;
  distanceM: number | null;
  averageSpeedMps: number | null;
  elevationGainM: number | null;
};

/**
 * The raw value a given metric reads off an activity. `fastest_avg_pace`
 * deliberately reads `averageSpeedMps` (bigger = faster = better) — the
 * model never stores pace directly (save-activity-v1.md §2.2), so "beats
 * the record" is always a ">" comparison on the stored magnitude, never a
 * pace string.
 */
export function extractCandidateValue(metric: PrMetric, activity: ActivityMetricSource): number | null {
  switch (metric) {
    case 'longest_duration':
      return activity.durationSeconds;
    case 'longest_distance':
      return activity.distanceM;
    case 'fastest_avg_pace':
      return activity.averageSpeedMps;
    case 'most_elevation_gain':
      return activity.elevationGainM;
    default:
      return null;
  }
}

export type CachedRecord = { value: number };

export type PrEvaluation = {
  metric: PrMetric;
  value: number;
  previousValue: number | null;
  isFirstEver: boolean;
};

/**
 * Compares each candidate metric's value against the cached current best.
 * Strictly-greater wins (matches the server's `>=`-vs-cache semantics at the
 * detection boundary — ties are not a new PR). No cached row at all means
 * "first activity of this type/metric ever" (design doc: "First Run on
 * record — 8.0 km. (no negative '+' delta, no implied comparison to zero)").
 */
export function evaluateCandidates(
  activity: ActivityMetricSource,
  flags: ActivityTypeMetricFlags,
  cache: ReadonlyMap<PrMetric, CachedRecord>
): PrEvaluation[] {
  const results: PrEvaluation[] = [];
  for (const metric of candidateMetricsForType(flags)) {
    const value = extractCandidateValue(metric, activity);
    if (value == null) continue;

    const existing = cache.get(metric);
    if (!existing) {
      results.push({ metric, value, previousValue: null, isFirstEver: true });
    } else if (value > existing.value) {
      results.push({ metric, value, previousValue: existing.value, isFirstEver: false });
    }
  }
  return results;
}

/**
 * Reconciliation diff: which optimistically-celebrated metrics did the
 * server confirm vs. retract (§CORE-04: "if the server disagrees ... quietly
 * correct the badge"). `serverMetrics` is the `achievements[].metric` array
 * from the `save_activity_v1` response.
 */
export function diffAchievements(
  optimisticMetrics: readonly PrMetric[],
  serverMetrics: readonly PrMetric[]
): { confirmed: PrMetric[]; retracted: PrMetric[] } {
  const serverSet = new Set(serverMetrics);
  return {
    confirmed: optimisticMetrics.filter((m) => serverSet.has(m)),
    retracted: optimisticMetrics.filter((m) => !serverSet.has(m)),
  };
}
