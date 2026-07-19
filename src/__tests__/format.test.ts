import {
  formatDuration,
  formatPace,
  formatRelativeDateTime,
  formatWeekLabel,
  metersToDisplayDistance,
  paceSecondsPerUnit,
  weekKeyFor,
} from '../lib/format';

describe('formatDuration', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatDuration(65)).toBe('1:05');
  });

  it('formats an hour+ as H:MM:SS', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('never shows negative or NaN — falls back to a placeholder', () => {
    expect(formatDuration(-5)).toBe('--:--');
    expect(formatDuration(NaN)).toBe('--:--');
    expect(formatDuration(null)).toBe('--:--');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0:00');
  });
});

describe('metersToDisplayDistance', () => {
  it('converts to km', () => {
    expect(metersToDisplayDistance(5000, 'km')).toBeCloseTo(5, 5);
  });

  it('converts to miles', () => {
    expect(metersToDisplayDistance(1609.344, 'mi')).toBeCloseTo(1, 5);
  });
});

describe('paceSecondsPerUnit / formatPace', () => {
  it('returns null pace for zero or missing speed (no divide-by-zero)', () => {
    expect(paceSecondsPerUnit(0, 'km')).toBeNull();
    expect(paceSecondsPerUnit(null, 'km')).toBeNull();
    expect(formatPace(0, 'km')).toBe('--:--');
  });

  it('derives a 5:00/km pace from a 3.333 m/s average speed', () => {
    // 1000m / 3.3333 m/s = 300s = 5:00
    expect(formatPace(1000 / 300, 'km')).toBe('5:00');
  });

  it('derives pace per mile using the mile conversion', () => {
    const paceSeconds = paceSecondsPerUnit(1609.344 / 480, 'mi'); // 8:00/mi
    expect(paceSeconds).toBeCloseTo(480, 0);
  });
});

describe('weekKeyFor / formatWeekLabel', () => {
  it('buckets a Wednesday into the Monday of that week', () => {
    // 2026-07-22 is a Wednesday.
    expect(weekKeyFor('2026-07-22T10:00:00.000Z')).toBe('2026-07-20');
  });

  it('labels the current week as "This week"', () => {
    const now = new Date('2026-07-22T10:00:00.000Z');
    expect(formatWeekLabel(weekKeyFor(now.toISOString()), now)).toBe('This week');
  });

  it('labels the prior week as "Last week"', () => {
    const now = new Date('2026-07-22T10:00:00.000Z');
    expect(formatWeekLabel('2026-07-13', now)).toBe('Last week');
  });
});

describe('formatRelativeDateTime', () => {
  it('labels today with a time', () => {
    const now = new Date('2026-07-22T18:00:00.000Z');
    const label = formatRelativeDateTime('2026-07-22T07:04:00.000Z', now);
    expect(label.startsWith('Today ·')).toBe(true);
  });

  it('labels yesterday distinctly from today', () => {
    const now = new Date('2026-07-22T18:00:00.000Z');
    const label = formatRelativeDateTime('2026-07-21T07:04:00.000Z', now);
    expect(label.startsWith('Yesterday ·')).toBe(true);
  });
});
