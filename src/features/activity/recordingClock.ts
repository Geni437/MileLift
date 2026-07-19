/**
 * Pure time math for the recording screen's two clocks (design doc CORE-01
 * "Metric semantics"):
 *   - MOVING time: stops while paused — the hero default and what
 *     `moving_time_seconds` records.
 *   - ELAPSED time: keeps counting through pauses — the spine's
 *     `duration_seconds`.
 * No Date.now() call baked in — every function takes `now` explicitly, so
 * this is deterministic and unit-testable (test-strategy).
 */

export type RecordingClockState = {
  status: 'recording' | 'paused';
  startedAt: string; // ISO — when "Start" was first tapped
  lastResumedAt: string; // ISO — most recent recording-segment start (= startedAt if never paused)
  accumulatedMovingSeconds: number; // moving seconds banked from prior segments
};

function safeDeltaSeconds(fromIso: string, now: Date): number {
  const deltaMs = now.getTime() - new Date(fromIso).getTime();
  return Math.max(0, deltaMs / 1000);
}

/** Moving time: banked seconds + the current segment if still recording, 0 more while paused. */
export function movingSeconds(state: RecordingClockState, now: Date): number {
  if (state.status === 'paused') return state.accumulatedMovingSeconds;
  return state.accumulatedMovingSeconds + safeDeltaSeconds(state.lastResumedAt, now);
}

/** Elapsed time: wall clock since Start, unconditionally — includes pauses. */
export function elapsedSeconds(state: Pick<RecordingClockState, 'startedAt'>, now: Date): number {
  return safeDeltaSeconds(state.startedAt, now);
}

/** New `accumulatedMovingSeconds` to persist the instant Pause is tapped. */
export function bankMovingSecondsOnPause(state: RecordingClockState, now: Date): number {
  if (state.status === 'paused') return state.accumulatedMovingSeconds;
  return state.accumulatedMovingSeconds + safeDeltaSeconds(state.lastResumedAt, now);
}
