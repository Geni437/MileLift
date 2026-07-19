/**
 * Display formatting for the metric face (duration/distance/pace/elevation).
 * Pure functions, no React import — the canonical stored unit is always SI
 * (architecture §1.2: "measured quantities are stored in canonical SI ...
 * display conversion happens in the client/API layer, never by mutating
 * stored values"). Every screen renders through these, never a one-off
 * `toFixed` in a component.
 */
import type { UnitDistanceSnapshot } from '../db/types';

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;

export function metersToDisplayDistance(meters: number, unit: UnitDistanceSnapshot): number {
  return unit === 'mi' ? meters / METERS_PER_MILE : meters / METERS_PER_KM;
}

/** "12.4" style distance value (1 decimal), unit label separate for MetricStat. */
export function formatDistanceValue(meters: number | null, unit: UnitDistanceSnapshot): string {
  if (meters == null) return '--';
  return metersToDisplayDistance(meters, unit).toFixed(meters >= METERS_PER_KM || unit === 'mi' ? 2 : 2);
}

/** `H:MM:SS` once past an hour, else `M:SS`. Never negative, never NaN. */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Average/current pace, derived on display from a speed (m/s) — the model
 * never stores pace directly (docs/api/save-activity-v1.md §2.2: "Pace is
 * derived client-side from this — never send/store pace directly").
 * Returns `null` for a stationary/unknown speed (0 or missing) rather than
 * a divide-by-zero "Infinity:NaN".
 */
export function paceSecondsPerUnit(speedMps: number | null, unit: UnitDistanceSnapshot): number | null {
  if (speedMps == null || speedMps <= 0) return null;
  const unitMeters = unit === 'mi' ? METERS_PER_MILE : METERS_PER_KM;
  return unitMeters / speedMps;
}

/** "5:12" min:sec per km/mi, or "--:--" when there's no meaningful pace yet. */
export function formatPace(speedMps: number | null, unit: UnitDistanceSnapshot): string {
  const secondsPerUnit = paceSecondsPerUnit(speedMps, unit);
  if (secondsPerUnit == null || !Number.isFinite(secondsPerUnit)) return '--:--';
  const totalSeconds = Math.round(secondsPerUnit);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatElevation(meters: number | null): string {
  if (meters == null) return '--';
  return Math.round(meters).toString();
}

export function formatHeartRate(bpm: number | null): string {
  if (bpm == null) return '--';
  return Math.round(bpm).toString();
}

/** "Today · 7:04" / "Tue" / "Mar 3" style relative date, per the design doc's ActivityRow spec. */
export function formatRelativeDateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (isToday) return `Today · ${time}`;
  if (isYesterday) return `Yesterday · ${time}`;

  const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toLocalDateString(date: Date): string {
  // Deliberately NOT `date.toISOString().slice(0, 10)` — that converts to
  // UTC first, which silently shifts the calendar date by one for any
  // positive-offset timezone once local midnight is set (a real bug this
  // module's own test suite caught). Build the string from local
  // year/month/day components instead.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local week key (Mon-start), used to group activities under a `WeekHeader`. */
export function weekKeyFor(iso: string): string {
  const date = new Date(iso);
  const day = (date.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(date);
  monday.setDate(date.getDate() - day);
  monday.setHours(0, 0, 0, 0);
  return toLocalDateString(monday);
}

export function formatWeekLabel(weekKey: string, now: Date = new Date()): string {
  const monday = new Date(`${weekKey}T00:00:00`);
  const thisWeekKey = weekKeyFor(now.toISOString());
  if (weekKey === thisWeekKey) return 'This week';
  const lastWeek = new Date(now);
  lastWeek.setDate(now.getDate() - 7);
  if (weekKey === weekKeyFor(lastWeek.toISOString())) return 'Last week';
  return `Week of ${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
