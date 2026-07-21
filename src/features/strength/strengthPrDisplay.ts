/**
 * Strength PR display formatting — the Module C counterpart to
 * `../activity/prDisplay.ts`. Design ref: docs/design/screens-phase-2.md
 * §CORE-12 "PrCallout(s)."
 */
import { formatReps, formatVolumeValue, formatWeightValue } from '../../lib/format';
import type { StrengthPrMetric, UnitWeightSnapshot } from '../../db/types';

export const STRENGTH_PR_METRIC_ROW_LABEL: Record<StrengthPrMetric, string> = {
  heaviest_weight: 'Heaviest',
  estimated_1rm: 'Est. 1RM',
  best_set_volume: 'Best set volume',
  max_reps: 'Max reps',
};

export function formatStrengthPrHeadline(exerciseName: string, metric: StrengthPrMetric, isFirstEver: boolean): string {
  if (isFirstEver) return `First ${exerciseName} on record`;
  switch (metric) {
    case 'heaviest_weight':
      return `Heaviest ${exerciseName} yet`;
    case 'estimated_1rm':
      return `Best estimated 1RM on ${exerciseName}`;
    case 'best_set_volume':
      return `Best set volume on ${exerciseName}`;
    case 'max_reps':
    default:
      return `Most reps on ${exerciseName} yet`;
  }
}

export function formatStrengthPrValue(metric: StrengthPrMetric, value: number, unit: UnitWeightSnapshot): string {
  switch (metric) {
    case 'heaviest_weight':
    case 'estimated_1rm':
      return `${formatWeightValue(value, unit)} ${unit}`;
    case 'best_set_volume':
      return `${formatVolumeValue(value, unit)} ${unit}`;
    case 'max_reps':
    default:
      return `${formatReps(value)} reps`;
  }
}

/** "+5 kg over your last best" style delta — `null` for first-ever (no implied comparison to zero). */
export function formatStrengthPrDelta(metric: StrengthPrMetric, value: number, previousValue: number | null, unit: UnitWeightSnapshot): string | null {
  if (previousValue == null) return null;
  const diff = value - previousValue;
  switch (metric) {
    case 'heaviest_weight':
    case 'estimated_1rm':
      return `+${formatWeightValue(diff, unit)} ${unit} over your last best`;
    case 'best_set_volume':
      return `+${formatVolumeValue(diff, unit)} ${unit} over your last best`;
    case 'max_reps':
      return `+${Math.round(diff)} reps over your last best`;
    default:
      return null;
  }
}
