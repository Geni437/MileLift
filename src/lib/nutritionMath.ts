/**
 * Pure serving/macro resolution math (architecture §2.3 "unit normalization,"
 * design doc `ServingControl`: "Live-recomputes the resolved kcal + P/C/F
 * ON-DEVICE from the snapshot math (`grams = quantity × serving_g_or_ml`;
 * `macros = grams/100 × per-basis`) — the numbers the user sees are the
 * numbers snapshotted at save." No React import — pure functions, unit-
 * tested directly (test-strategy skill).
 */

export type PerBasisMacros = {
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
};

export type ResolvedMacros = {
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
};

/**
 * Resolves a logged quantity of a serving into the macros to snapshot.
 * `perBasis` is the food's macros per 100 g/ml (the canonical `basis`,
 * architecture §2.3); `servingGOrMl` is the weight of ONE serving;
 * `quantity` is how many of that serving were logged.
 *
 * grams = quantity × servingGOrMl
 * macro = grams / 100 × perBasisMacro
 */
export function resolveServingMacros(perBasis: PerBasisMacros, servingGOrMl: number, quantity: number): ResolvedMacros {
  if (!(servingGOrMl > 0) || !(quantity > 0)) {
    return { energyKcal: 0, proteinG: perBasis.proteinG != null ? 0 : null, carbG: perBasis.carbG != null ? 0 : null, fatG: perBasis.fatG != null ? 0 : null };
  }
  const grams = quantity * servingGOrMl;
  const ratio = grams / 100;
  return {
    energyKcal: roundMacro(perBasis.energyKcal * ratio),
    proteinG: perBasis.proteinG != null ? roundMacro(perBasis.proteinG * ratio) : null,
    carbG: perBasis.carbG != null ? roundMacro(perBasis.carbG * ratio) : null,
    fatG: perBasis.fatG != null ? roundMacro(perBasis.fatG * ratio) : null,
  };
}

/** Macro values are stored with modest precision (matches the RPC's own example responses, e.g. `47.798`) — round to 3dp to avoid floating-point noise without fabricating false precision. */
function roundMacro(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type MacroTotals = {
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
};

/** Sums a meal's non-deleted items into the meal-level snapshot totals (§1.5 — the client-side mirror of what the save RPC recomputes server-side). */
export function sumItemMacros(items: { energyKcal: number; proteinG: number | null; carbG: number | null; fatG: number | null; deletedAt?: string | null }[]): MacroTotals {
  const live = items.filter((i) => !i.deletedAt);
  if (live.length === 0) return { energyKcal: 0, proteinG: null, carbG: null, fatG: null };
  let energyKcal = 0;
  let proteinG: number | null = null;
  let carbG: number | null = null;
  let fatG: number | null = null;
  for (const item of live) {
    energyKcal += item.energyKcal;
    if (item.proteinG != null) proteinG = (proteinG ?? 0) + item.proteinG;
    if (item.carbG != null) carbG = (carbG ?? 0) + item.carbG;
    if (item.fatG != null) fatG = (fatG ?? 0) + item.fatG;
  }
  return { energyKcal: roundMacro(energyKcal), proteinG: proteinG != null ? roundMacro(proteinG) : null, carbG: carbG != null ? roundMacro(carbG) : null, fatG: fatG != null ? roundMacro(fatG) : null };
}

export type OverlapWindow = { occurredAt: string; durationSeconds: number };

/** Default overlap-advisory window when no duration is given (§4.3/`BURN §3.3`'s named `v_default_advisory_window` — mirrored client-side so the optimistic pre-sync check and the server's post-sync check agree, §CORE-Sync coordination note). */
export const DEFAULT_OVERLAP_WINDOW_MINUTES = 30;

/** Do two [start, start+duration) windows intersect? Mirrors `save_manual_burn_v1`'s own overlap test (§3.3) so the client-side optimistic pre-check and the server's authoritative check can't visibly diverge. */
export function windowsOverlap(a: OverlapWindow, b: OverlapWindow): boolean {
  const aStart = new Date(a.occurredAt).getTime();
  const aEnd = aStart + Math.max(0, a.durationSeconds) * 1000;
  const bStart = new Date(b.occurredAt).getTime();
  const bEnd = bStart + Math.max(0, b.durationSeconds) * 1000;
  return aStart < bEnd && bStart < aEnd;
}
