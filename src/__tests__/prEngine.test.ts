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
});
