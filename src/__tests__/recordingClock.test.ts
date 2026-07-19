import { bankMovingSecondsOnPause, elapsedSeconds, movingSeconds } from '../features/activity/recordingClock';

const START = '2026-07-22T10:00:00.000Z';

describe('movingSeconds', () => {
  it('counts from lastResumedAt while recording', () => {
    const now = new Date('2026-07-22T10:05:00.000Z'); // +5 min
    const state = { status: 'recording' as const, startedAt: START, lastResumedAt: START, accumulatedMovingSeconds: 0 };
    expect(movingSeconds(state, now)).toBeCloseTo(300, 0);
  });

  it('freezes at the banked value while paused, ignoring elapsed wall-clock', () => {
    const now = new Date('2026-07-22T10:30:00.000Z'); // long after pause
    const state = { status: 'paused' as const, startedAt: START, lastResumedAt: START, accumulatedMovingSeconds: 300 };
    expect(movingSeconds(state, now)).toBe(300);
  });

  it('adds the current segment on top of banked seconds after a resume', () => {
    const resumedAt = '2026-07-22T10:10:00.000Z';
    const now = new Date('2026-07-22T10:11:00.000Z'); // +1 min into the new segment
    const state = { status: 'recording' as const, startedAt: START, lastResumedAt: resumedAt, accumulatedMovingSeconds: 300 };
    expect(movingSeconds(state, now)).toBeCloseTo(360, 0);
  });
});

describe('elapsedSeconds', () => {
  it('keeps counting through a pause (unlike movingSeconds)', () => {
    const now = new Date('2026-07-22T10:20:00.000Z'); // +20 min
    expect(elapsedSeconds({ startedAt: START }, now)).toBeCloseTo(1200, 0);
  });

  it('never goes negative for a clock-skew edge case', () => {
    const now = new Date('2026-07-22T09:59:00.000Z'); // before start
    expect(elapsedSeconds({ startedAt: START }, now)).toBe(0);
  });
});

describe('bankMovingSecondsOnPause', () => {
  it('adds the just-finished segment to the bank', () => {
    const now = new Date('2026-07-22T10:05:00.000Z');
    const state = { status: 'recording' as const, startedAt: START, lastResumedAt: START, accumulatedMovingSeconds: 60 };
    expect(bankMovingSecondsOnPause(state, now)).toBeCloseTo(360, 0);
  });

  it('is a no-op if already paused (idempotent double-pause safety)', () => {
    const now = new Date('2026-07-22T10:30:00.000Z');
    const state = { status: 'paused' as const, startedAt: START, lastResumedAt: START, accumulatedMovingSeconds: 300 };
    expect(bankMovingSecondsOnPause(state, now)).toBe(300);
  });
});
