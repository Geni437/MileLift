/**
 * PR display formatting — pure, metric-aware (a distance PR formats
 * differently from a pace or duration PR). Feeds `PrCallout` and
 * `RecordRow`. Design ref: docs/design/screens-phase-1.md CORE-04.
 */
import { formatDistanceValue, formatDuration, formatElevation, formatPace, paceSecondsPerUnit } from '../../lib/format';
import type { PrMetric, UnitDistanceSnapshot } from '../../db/types';

export const PR_METRIC_ROW_LABEL: Record<PrMetric, string> = {
  longest_distance: 'Farthest',
  fastest_avg_pace: 'Fastest pace',
  longest_duration: 'Longest',
  most_elevation_gain: 'Most climbing',
};

export function formatPrHeadline(activityTypeName: string, metric: PrMetric, isFirstEver: boolean): string {
  if (isFirstEver) return `First ${activityTypeName} on record`;
  switch (metric) {
    case 'longest_distance':
      return `Farthest ${activityTypeName} yet`;
    case 'fastest_avg_pace':
      return `Fastest ${activityTypeName} yet`;
    case 'most_elevation_gain':
      return `Most climbing on a ${activityTypeName} yet`;
    case 'longest_duration':
    default:
      return `Longest ${activityTypeName} yet`;
  }
}

export function formatPrValue(metric: PrMetric, value: number, unit: UnitDistanceSnapshot): string {
  switch (metric) {
    case 'longest_distance':
      return `${formatDistanceValue(value, unit)} ${unit}`;
    case 'fastest_avg_pace':
      return `${formatPace(value, unit)} /${unit}`;
    case 'most_elevation_gain':
      return `${formatElevation(value)} m`;
    case 'longest_duration':
    default:
      return formatDuration(value);
  }
}

/** "+1.2 km over your last best" style delta — `null` when there's no previous value (first-ever, handled separately with "no implied comparison to zero"). */
export function formatPrDelta(metric: PrMetric, value: number, previousValue: number | null, unit: UnitDistanceSnapshot): string | null {
  if (previousValue == null) return null;
  const diff = value - previousValue;

  switch (metric) {
    case 'longest_distance':
      return `+${formatDistanceValue(diff, unit)} ${unit} over your last best`;
    case 'longest_duration':
      return `+${formatDuration(diff)} over your last best`;
    case 'most_elevation_gain':
      return `+${formatElevation(diff)} m over your last best`;
    case 'fastest_avg_pace': {
      const prevPaceSeconds = paceSecondsPerUnit(previousValue, unit);
      const newPaceSeconds = paceSecondsPerUnit(value, unit);
      if (prevPaceSeconds == null || newPaceSeconds == null) return null;
      const deltaSeconds = Math.round(prevPaceSeconds - newPaceSeconds); // positive = faster
      const abs = Math.abs(deltaSeconds);
      const sign = deltaSeconds >= 0 ? '-' : '+';
      return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}/${unit} over your last best`;
    }
    default:
      return null;
  }
}
