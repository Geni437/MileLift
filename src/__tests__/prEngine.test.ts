import { candidateMetricsForType, diffAchievements, evaluateCandidates, extractCandidateValue } from '../features/activity/prEngine';
import type { PrMetric } from '../db/types';

describe('candidateMetricsForType', () => {
  it('always includes longest_duration', () => {
    expect(candidateMetricsForType({ isDistanceBased: false, tracksElevation: false })).toEqual(['longest_duration']);
  });

  it('adds distance/pace metrics for distance-based types', () => {
    const metrics = candidateMetricsForType({ isDistanceBased: true, tracksElevation: false });
    expect(metrics).toEqual(['longest_duration', 'longest_distance', 'fastest_avg_pace']);
  });

  it('adds elevation metric only when the type tracks elevation', () => {
    const metrics = candidateMetricsForType({ isDistanceBased: true, tracksElevation: true });
    expect(metrics).toContain('most_elevation_gain');
  });
});

describe('extractCandidateValue', () => {
  const activity = { durationSeconds: 1800, distanceM: 5000, averageSpeedMps: 3.3, elevationGainM: 120 };

  it('reads the right field per metric', () => {
    expect(extractCandidateValue('longest_duration', activity)).toBe(1800);
    expect(extractCandidateValue('longest_distance', activity)).toBe(5000);
    expect(extractCandidateValue('fastest_avg_pace', activity)).toBe(3.3);
    expect(extractCandidateValue('most_elevation_gain', activity)).toBe(120);
  });
});

describe('evaluateCandidates', () => {
  const flags = { isDistanceBased: true, tracksElevation: true };

  it('treats a metric with no cached record as a first-ever PR, not a comparison to zero', () => {
    const activity = { durationSeconds: 1800, distanceM: 5000, averageSpeedMps: 3, elevationGainM: 50 };
    const results = evaluateCandidates(activity, flags, new Map());
    const distance = results.find((r) => r.metric === 'longest_distance')!;
    expect(distance.isFirstEver).toBe(true);
    expect(distance.previousValue).toBeNull();
  });

  it('beats a cached record when strictly greater', () => {
    const cache = new Map([['longest_distance', { value: 4000 }] as [PrMetric, { value: number }]]);
    const activity = { durationSeconds: 1800, distanceM: 5000, averageSpeedMps: null, elevationGainM: null };
    const results = evaluateCandidates(activity, { isDistanceBased: true, tracksElevation: false }, cache);
    const distance = results.find((r) => r.metric === 'longest_distance')!;
    expect(distance.value).toBe(5000);
    expect(distance.previousValue).toBe(4000);
    expect(distance.isFirstEver).toBe(false);
  });

  it('does NOT count a tie as a new PR', () => {
    const cache = new Map([['longest_distance', { value: 5000 }] as [PrMetric, { value: number }]]);
    const activity = { durationSeconds: 1800, distanceM: 5000, averageSpeedMps: null, elevationGainM: null };
    const results = evaluateCandidates(activity, { isDistanceBased: true, tracksElevation: false }, cache);
    expect(results.find((r) => r.metric === 'longest_distance')).toBeUndefined();
  });

  it('skips a metric whose source value is null (e.g. no elevation data)', () => {
    const activity = { durationSeconds: 1800, distanceM: null, averageSpeedMps: null, elevationGainM: null };
    const results = evaluateCandidates(activity, flags, new Map());
    expect(results.find((r) => r.metric === 'longest_distance')).toBeUndefined();
    expect(results.find((r) => r.metric === 'longest_duration')).toBeDefined();
  });

  // Realistic-history requirement (architecture §4.1): "an activity can set
  // some metrics as PRs and not others in the same save" — a single save
  // must independently evaluate every applicable metric, not short-circuit
  // or couple them together.
  it('beats some cached metrics and not others in the same evaluation (partial PR)', () => {
    const cache = new Map<PrMetric, { value: number }>([
      ['longest_distance', { value: 10000 }], // activity (12000) WILL beat this
      ['fastest_avg_pace', { value: 4.0 }], // activity (3.2 mps) will NOT beat this (slower)
      ['longest_duration', { value: 3000 }], // activity (3600) WILL beat this
      ['most_elevation_gain', { value: 500 }], // activity (500, tie) will NOT beat this
    ]);
    const activity = { durationSeconds: 3600, distanceM: 12000, averageSpeedMps: 3.2, elevationGainM: 500 };
    const results = evaluateCandidates(activity, flags, cache);

    const metrics = results.map((r) => r.metric).sort();
    expect(metrics).toEqual(['longest_distance', 'longest_duration'].sort());
    expect(results.find((r) => r.metric === 'fastest_avg_pace')).toBeUndefined();
    expect(results.find((r) => r.metric === 'most_elevation_gain')).toBeUndefined();
  });

  it('treats every metric as first-ever independently when the cache is empty, even at a zero value', () => {
    // A manual/indoor activity can legitimately log 0 elevation gain — this
    // must still register as a real (if unexciting) first-ever record, not
    // be silently dropped because 0 looks falsy.
    const activity = { durationSeconds: 600, distanceM: 0, averageSpeedMps: 0, elevationGainM: 0 };
    const results = evaluateCandidates(activity, flags, new Map());
    const distance = results.find((r) => r.metric === 'longest_distance')!;
    expect(distance).toBeDefined();
    expect(distance.value).toBe(0);
    expect(distance.isFirstEver).toBe(true);
  });

  it('omits elevation from candidates entirely for a type that does not track it, even if the activity has elevation data', () => {
    // e.g. an indoor_ride activity_type has tracks_elevation = false in the
    // live seed (20260719133100_create_activity_types.sql) — a stray
    // elevation_gain_m value on such a row must never be evaluated as a PR
    // candidate, matching the server's `if v_activity_type.tracks_elevation`
    // gate in save_activity_v1.
    const indoorFlags = { isDistanceBased: true, tracksElevation: false };
    const activity = { durationSeconds: 1800, distanceM: 5000, averageSpeedMps: 2.8, elevationGainM: 300 };
    const results = evaluateCandidates(activity, indoorFlags, new Map());
    expect(results.find((r) => r.metric === 'most_elevation_gain')).toBeUndefined();
    expect(candidateMetricsForType(indoorFlags)).not.toContain('most_elevation_gain');
  });
});

describe('diffAchievements', () => {
  it('confirms metrics the server also reports', () => {
    const { confirmed, retracted } = diffAchievements(['longest_distance', 'longest_duration'], ['longest_distance']);
    expect(confirmed).toEqual(['longest_distance']);
    expect(retracted).toEqual(['longest_duration']);
  });

  it('retracts nothing when the server confirms everything', () => {
    const { retracted } = diffAchievements(['longest_distance'], ['longest_distance', 'longest_duration']);
    expect(retracted).toEqual([]);
  });

  it('retracts every optimistic metric when the server confirms none of them (e.g. an edit that demoted this activity below another)', () => {
    const { confirmed, retracted } = diffAchievements(['longest_distance', 'fastest_avg_pace'], []);
    expect(confirmed).toEqual([]);
    expect(retracted).toEqual(['longest_distance', 'fastest_avg_pace']);
  });

  it('produces no retraction when nothing was celebrated optimistically, even if the server found surplus achievements', () => {
    // This is the "first sync ever, no local cache yet" case called out in
    // activitySync.ts's reconcilePrs comment: a server-only achievement
    // (metric the client never optimistically celebrated, e.g. because its
    // local personal_records cache didn't have that metric yet) must not be
    // reported as a retraction. diffAchievements only ever narrows the
    // optimistic set down (confirmed ⊆ optimistic, retracted ⊆ optimistic) —
    // it deliberately does NOT surface server-only surplus achievements;
    // that is reconcilePrs's job (it iterates serverAchievements directly,
    // not through this function's `confirmed` list) — asserted here so a
    // future refactor of diffAchievements doesn't silently break that
    // division of responsibility.
    const { confirmed, retracted } = diffAchievements([], ['longest_distance']);
    expect(confirmed).toEqual([]);
    expect(retracted).toEqual([]);
  });

  it('is idempotent-safe against a duplicate metric appearing in the optimistic list', () => {
    const { confirmed, retracted } = diffAchievements(
      ['longest_distance', 'longest_distance'],
      ['longest_distance']
    );
    expect(confirmed).toEqual(['longest_distance', 'longest_distance']);
    expect(retracted).toEqual([]);
  });
});
