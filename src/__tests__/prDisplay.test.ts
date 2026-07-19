import { formatPrDelta, formatPrHeadline, formatPrValue } from '../features/activity/prDisplay';

describe('formatPrHeadline', () => {
  it('uses "First ... on record" copy with no comparison implied for a first-ever PR', () => {
    expect(formatPrHeadline('Run', 'longest_distance', true)).toBe('First Run on record');
  });

  it('uses the metric-specific "yet" phrasing for a beaten record', () => {
    expect(formatPrHeadline('Run', 'longest_distance', false)).toBe('Farthest Run yet');
    expect(formatPrHeadline('Run', 'fastest_avg_pace', false)).toBe('Fastest Run yet');
    expect(formatPrHeadline('Hike', 'most_elevation_gain', false)).toBe('Most climbing on a Hike yet');
    expect(formatPrHeadline('Ride', 'longest_duration', false)).toBe('Longest Ride yet');
  });
});

describe('formatPrValue', () => {
  it('formats a distance PR with its unit', () => {
    expect(formatPrValue('longest_distance', 12400, 'km')).toBe('12.40 km');
  });

  it('formats a duration PR as H:MM:SS', () => {
    expect(formatPrValue('longest_duration', 3725, 'km')).toBe('1:02:05');
  });

  it('formats an elevation PR in whole meters', () => {
    expect(formatPrValue('most_elevation_gain', 812.6, 'km')).toBe('813 m');
  });
});

describe('formatPrDelta', () => {
  it('returns null for a first-ever PR (no implied comparison to zero)', () => {
    expect(formatPrDelta('longest_distance', 8000, null, 'km')).toBeNull();
  });

  it('formats a distance delta', () => {
    expect(formatPrDelta('longest_distance', 12400, 11200, 'km')).toBe('+1.20 km over your last best');
  });

  it('formats a pace delta as a faster (negative-signed) time when the new pace is quicker', () => {
    // previous 6:00/km (360s), new 5:30/km (330s) -> 30s faster -> "-0:30/km"
    const previousSpeedMps = 1000 / 360;
    const newSpeedMps = 1000 / 330;
    expect(formatPrDelta('fastest_avg_pace', newSpeedMps, previousSpeedMps, 'km')).toBe('-0:30/km over your last best');
  });
});
