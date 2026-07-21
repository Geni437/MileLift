import {
  candidateMetricsForExercise,
  diffStrengthAchievements,
  estimateEpley1Rm,
  evaluateExerciseCandidates,
  extractCandidateValue,
  type SetCandidateSource,
} from '../features/strength/strengthPrEngine';
import type { StrengthPrMetric } from '../db/types';

describe('estimateEpley1Rm', () => {
  it('computes weight * (1 + reps/30), matching the RPC/architecture §4.2/§12 formula exactly', () => {
    // 100kg x 5 reps -> 100 * (1 + 5/30) = 116.666...
    expect(estimateEpley1Rm(100, 5)).toBeCloseTo(116.6667, 3);
  });

  it('returns null when weight or reps is missing', () => {
    expect(estimateEpley1Rm(null, 5)).toBeNull();
    expect(estimateEpley1Rm(100, null)).toBeNull();
  });

  it('returns null for zero or negative reps (nothing to estimate from)', () => {
    expect(estimateEpley1Rm(100, 0)).toBeNull();
    expect(estimateEpley1Rm(100, -1)).toBeNull();
  });

  it('returns null for negative weight (should never happen post-validation, but never silently miscompute)', () => {
    expect(estimateEpley1Rm(-5, 5)).toBeNull();
  });
});

describe('candidateMetricsForExercise', () => {
  it('weighted movement gets heaviest_weight/estimated_1rm/best_set_volume', () => {
    expect(candidateMetricsForExercise({ isWeighted: true, isBodyweight: false })).toEqual([
      'heaviest_weight',
      'estimated_1rm',
      'best_set_volume',
    ]);
  });

  it('bodyweight movement gets max_reps', () => {
    expect(candidateMetricsForExercise({ isWeighted: false, isBodyweight: true })).toEqual(['max_reps']);
  });

  it('a weighted bodyweight movement (e.g. weighted pull-up) gets both sets of metrics', () => {
    const metrics = candidateMetricsForExercise({ isWeighted: true, isBodyweight: true });
    expect(metrics).toEqual(expect.arrayContaining(['heaviest_weight', 'estimated_1rm', 'best_set_volume', 'max_reps']));
  });
});

describe('extractCandidateValue', () => {
  const set: SetCandidateSource = {
    sourceSetLogId: 's1',
    reps: 5,
    weightKg: 100,
    estimated1rmKg: 116.7,
    setType: 'working',
    isCompleted: true,
  };

  it('reads the right field per metric', () => {
    expect(extractCandidateValue('heaviest_weight', set)).toBe(100);
    expect(extractCandidateValue('estimated_1rm', set)).toBe(116.7);
    expect(extractCandidateValue('best_set_volume', set)).toBe(500);
    expect(extractCandidateValue('max_reps', set)).toBe(5);
  });

  it('best_set_volume is null when reps or weight is missing', () => {
    expect(extractCandidateValue('best_set_volume', { ...set, weightKg: null })).toBeNull();
  });
});

describe('evaluateExerciseCandidates', () => {
  const weighted = { isWeighted: true, isBodyweight: false };

  function workingSet(overrides: Partial<SetCandidateSource>): SetCandidateSource {
    return { sourceSetLogId: 'set', reps: 5, weightKg: 100, estimated1rmKg: 116.7, setType: 'working', isCompleted: true, ...overrides };
  }

  it('treats a metric with no cached record as first-ever, not a comparison to zero', () => {
    const results = evaluateExerciseCandidates('ex1', null, weighted, [workingSet({ sourceSetLogId: 's1' })], new Map(), 'kg');
    const heaviest = results.find((r) => r.metric === 'heaviest_weight')!;
    expect(heaviest.isFirstEver).toBe(true);
    expect(heaviest.previousValue).toBeNull();
    expect(heaviest.sourceSetLogId).toBe('s1');
  });

  it('beats a cached record when strictly greater', () => {
    const cache = new Map<StrengthPrMetric, { value: number }>([['heaviest_weight', { value: 90 }]]);
    const results = evaluateExerciseCandidates('ex1', null, weighted, [workingSet({ sourceSetLogId: 's1', weightKg: 100 })], cache, 'kg');
    const heaviest = results.find((r) => r.metric === 'heaviest_weight')!;
    expect(heaviest.value).toBe(100);
    expect(heaviest.previousValue).toBe(90);
  });

  it('does NOT count a tie as a new PR', () => {
    const cache = new Map<StrengthPrMetric, { value: number }>([['heaviest_weight', { value: 100 }]]);
    const results = evaluateExerciseCandidates('ex1', null, weighted, [workingSet({ weightKg: 100 })], cache, 'kg');
    expect(results.find((r) => r.metric === 'heaviest_weight')).toBeUndefined();
  });

  it('excludes warmup, failed, and incomplete sets from PR consideration (§4.1)', () => {
    const sets: SetCandidateSource[] = [
      workingSet({ sourceSetLogId: 'warmup', weightKg: 200, setType: 'warmup' }),
      workingSet({ sourceSetLogId: 'incomplete', weightKg: 300, isCompleted: false }),
      workingSet({ sourceSetLogId: 'real-best', weightKg: 100 }),
    ];
    const results = evaluateExerciseCandidates('ex1', null, weighted, sets, new Map(), 'kg');
    const heaviest = results.find((r) => r.metric === 'heaviest_weight')!;
    expect(heaviest.value).toBe(100);
    expect(heaviest.sourceSetLogId).toBe('real-best');
  });

  // This is the exact bug the RPC's own migration (20260721110300) fixed
  // server-side: an ascending/pyramid session logging the same exercise
  // multiple times in one save must yield ONE candidate per metric (the
  // call's own best), not one "beat" per set. Replicated here so the
  // client-side optimistic badge never diverges from what the server will
  // eventually confirm.
  it('batches an ascending pyramid session to ONE candidate per metric, not one per set', () => {
    const sets: SetCandidateSource[] = [
      workingSet({ sourceSetLogId: 'set-100', weightKg: 100 }),
      workingSet({ sourceSetLogId: 'set-105', weightKg: 105 }),
      workingSet({ sourceSetLogId: 'set-110', weightKg: 110 }),
    ];
    const results = evaluateExerciseCandidates('ex1', null, weighted, sets, new Map(), 'kg');
    const heaviestResults = results.filter((r) => r.metric === 'heaviest_weight');
    expect(heaviestResults).toHaveLength(1);
    expect(heaviestResults[0].value).toBe(110);
    expect(heaviestResults[0].sourceSetLogId).toBe('set-110');
  });

  it('bodyweight-only exercise never evaluates weighted metrics', () => {
    const results = evaluateExerciseCandidates('ex1', null, { isWeighted: false, isBodyweight: true }, [workingSet({ reps: 12 })], new Map(), 'kg');
    expect(results.map((r) => r.metric)).toEqual(['max_reps']);
  });

  it('carries the given exercise/custom-exercise ref and unit snapshot through untouched', () => {
    const results = evaluateExerciseCandidates(null, 'custom-1', weighted, [workingSet({})], new Map(), 'lb');
    expect(results.every((r) => r.exerciseId === null && r.customExerciseId === 'custom-1' && r.unitSnapshot === 'lb')).toBe(true);
  });
});

describe('diffStrengthAchievements', () => {
  it('confirms metrics the server also reports and retracts the rest', () => {
    const { confirmed, retracted } = diffStrengthAchievements(['heaviest_weight', 'estimated_1rm'], ['heaviest_weight']);
    expect(confirmed).toEqual(['heaviest_weight']);
    expect(retracted).toEqual(['estimated_1rm']);
  });

  it('never surfaces a server-only surplus achievement as a "confirmed" entry not already optimistic', () => {
    const { confirmed, retracted } = diffStrengthAchievements([], ['heaviest_weight']);
    expect(confirmed).toEqual([]);
    expect(retracted).toEqual([]);
  });
});
