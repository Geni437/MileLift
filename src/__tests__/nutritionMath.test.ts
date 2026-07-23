import { DEFAULT_OVERLAP_WINDOW_MINUTES, resolveServingMacros, sumItemMacros, windowsOverlap } from '../lib/nutritionMath';

describe('resolveServingMacros', () => {
  it('resolves a whole-serving quantity against per-100g macros', () => {
    // 1 serving of 150g, food is 200 kcal / 100g -> 300 kcal for this serving.
    const resolved = resolveServingMacros({ energyKcal: 200, proteinG: 20, carbG: 10, fatG: 5 }, 150, 1);
    expect(resolved.energyKcal).toBeCloseTo(300, 3);
    expect(resolved.proteinG).toBeCloseTo(30, 3);
    expect(resolved.carbG).toBeCloseTo(15, 3);
    expect(resolved.fatG).toBeCloseTo(7.5, 3);
  });

  it('scales linearly with quantity', () => {
    const oneServing = resolveServingMacros({ energyKcal: 100, proteinG: 5, carbG: null, fatG: null }, 50, 1);
    const twoServings = resolveServingMacros({ energyKcal: 100, proteinG: 5, carbG: null, fatG: null }, 50, 2);
    expect(twoServings.energyKcal).toBeCloseTo(oneServing.energyKcal * 2, 3);
    expect(twoServings.proteinG).toBeCloseTo((oneServing.proteinG ?? 0) * 2, 3);
  });

  it('preserves null macros (a food with no protein/carb/fat on record) as null, not zero', () => {
    const resolved = resolveServingMacros({ energyKcal: 50, proteinG: null, carbG: null, fatG: null }, 100, 1);
    expect(resolved.proteinG).toBeNull();
    expect(resolved.carbG).toBeNull();
    expect(resolved.fatG).toBeNull();
  });

  it('never returns a negative or NaN figure for an invalid serving/quantity', () => {
    const resolved = resolveServingMacros({ energyKcal: 200, proteinG: 20, carbG: 10, fatG: 5 }, 0, 1);
    expect(resolved.energyKcal).toBe(0);
    const resolved2 = resolveServingMacros({ energyKcal: 200, proteinG: 20, carbG: 10, fatG: 5 }, 100, -1);
    expect(resolved2.energyKcal).toBe(0);
  });
});

describe('sumItemMacros', () => {
  it('sums energy and macros across non-deleted items', () => {
    const totals = sumItemMacros([
      { energyKcal: 100, proteinG: 10, carbG: 5, fatG: 2 },
      { energyKcal: 50, proteinG: 5, carbG: null, fatG: 1 },
    ]);
    expect(totals.energyKcal).toBeCloseTo(150, 3);
    expect(totals.proteinG).toBeCloseTo(15, 3);
    expect(totals.carbG).toBeCloseTo(5, 3);
    expect(totals.fatG).toBeCloseTo(3, 3);
  });

  it('excludes soft-deleted (tombstoned) items from the total — the CORE-06 "removed item never counts" rule', () => {
    const totals = sumItemMacros([
      { energyKcal: 100, proteinG: 10, carbG: 5, fatG: 2 },
      { energyKcal: 999, proteinG: 999, carbG: 999, fatG: 999, deletedAt: '2026-07-22T00:00:00Z' },
    ]);
    expect(totals.energyKcal).toBeCloseTo(100, 3);
  });

  it('returns an all-zero/null total for an empty or fully-tombstoned meal, never NaN', () => {
    expect(sumItemMacros([])).toEqual({ energyKcal: 0, proteinG: null, carbG: null, fatG: null });
    expect(sumItemMacros([{ energyKcal: 5, proteinG: 1, carbG: 1, fatG: 1, deletedAt: '2026-07-22T00:00:00Z' }])).toEqual({
      energyKcal: 0,
      proteinG: null,
      carbG: null,
      fatG: null,
    });
  });
});

describe('windowsOverlap — the CORE-11 overlap-advisory pre-check', () => {
  it('detects a genuinely overlapping window', () => {
    const a = { occurredAt: '2026-07-22T18:00:00Z', durationSeconds: 2700 }; // 18:00–18:45
    const b = { occurredAt: '2026-07-22T18:15:00Z', durationSeconds: 900 }; // 18:15–18:30, inside a
    expect(windowsOverlap(a, b)).toBe(true);
  });

  it('does not flag two genuinely separate windows the same day', () => {
    const morning = { occurredAt: '2026-07-22T07:00:00Z', durationSeconds: 3000 };
    const evening = { occurredAt: '2026-07-22T18:00:00Z', durationSeconds: 2700 };
    expect(windowsOverlap(morning, evening)).toBe(false);
  });

  it('treats back-to-back (touching, not overlapping) windows as non-overlapping', () => {
    const a = { occurredAt: '2026-07-22T18:00:00Z', durationSeconds: 1800 }; // ends 18:30
    const b = { occurredAt: '2026-07-22T18:30:00Z', durationSeconds: 1800 }; // starts 18:30
    expect(windowsOverlap(a, b)).toBe(false);
  });

  it('the default advisory window constant matches the RPC contract (30 minutes)', () => {
    expect(DEFAULT_OVERLAP_WINDOW_MINUTES).toBe(30);
  });
});
