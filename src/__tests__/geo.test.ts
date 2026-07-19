import {
  computeBounds,
  computeRollingSpeedMps,
  computeTrackSummary,
  geoJsonLineStringToPoints,
  haversineMeters,
  normalizeSeries,
  simplifyTrack,
  trackToGeoJsonLineString,
  type TrackPoint,
} from '../lib/geo';

function point(latitude: number, longitude: number, recordedAt: string, elevationM: number | null = null): TrackPoint {
  return { latitude, longitude, elevationM, accuracyM: 5, recordedAt };
}

describe('haversineMeters', () => {
  it('returns 0 for an identical point', () => {
    expect(haversineMeters({ latitude: 51.5, longitude: -0.1 }, { latitude: 51.5, longitude: -0.1 })).toBe(0);
  });

  it('approximates a known distance (roughly 1 degree of latitude ~ 111.2km)', () => {
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('computeTrackSummary', () => {
  it('returns zero distance / null elevation for fewer than 2 points', () => {
    const summary = computeTrackSummary([point(0, 0, '2026-01-01T00:00:00.000Z')]);
    expect(summary.distanceM).toBe(0);
    expect(summary.elevationGainM).toBeNull();
  });

  it('sums distance across consecutive points moving north', () => {
    const points = [
      point(0, 0, '2026-01-01T00:00:00.000Z'),
      point(0.001, 0, '2026-01-01T00:00:10.000Z'),
      point(0.002, 0, '2026-01-01T00:00:20.000Z'),
    ];
    const summary = computeTrackSummary(points);
    expect(summary.distanceM).toBeGreaterThan(200);
    expect(summary.distanceM).toBeLessThan(250);
  });

  it('rejects an implausible GPS spike rather than inflating distance', () => {
    const points = [
      point(0, 0, '2026-01-01T00:00:00.000Z'),
      // ~1 degree of longitude in 1 second is an impossible ~111km/s jump.
      point(0, 1, '2026-01-01T00:00:01.000Z'),
      point(0.0001, 1, '2026-01-01T00:00:02.000Z'),
    ];
    const summary = computeTrackSummary(points);
    // The spike segment is rejected; only the small final segment counts.
    expect(summary.distanceM).toBeLessThan(50);
  });

  it('accumulates elevation gain and loss, ignoring sub-meter jitter', () => {
    const points = [
      point(0, 0, '2026-01-01T00:00:00.000Z', 100),
      point(0.0001, 0, '2026-01-01T00:00:10.000Z', 100.4), // noise, ignored
      point(0.0002, 0, '2026-01-01T00:00:20.000Z', 105), // real gain
      point(0.0003, 0, '2026-01-01T00:00:30.000Z', 98), // real loss
    ];
    const summary = computeTrackSummary(points);
    // Gain is measured segment-to-segment, not against a fixed baseline —
    // the ignored 0.4m noise segment (100 -> 100.4) means the counted gain
    // is 100.4 -> 105 = 4.6, not the full 100 -> 105 = 5.
    expect(summary.elevationGainM).toBeCloseTo(4.6, 1);
    expect(summary.elevationLossM).toBeCloseTo(7, 1);
  });

  it('reports null elevation gain/loss when no point carries elevation', () => {
    const points = [point(0, 0, '2026-01-01T00:00:00.000Z'), point(0.001, 0, '2026-01-01T00:00:10.000Z')];
    const summary = computeTrackSummary(points);
    expect(summary.elevationGainM).toBeNull();
    expect(summary.elevationLossM).toBeNull();
  });
});

describe('simplifyTrack', () => {
  it('leaves short tracks untouched', () => {
    const points = [point(0, 0, 't1'), point(0, 1, 't2')];
    expect(simplifyTrack(points)).toHaveLength(2);
  });

  it('drops near-collinear points within tolerance', () => {
    const points = Array.from({ length: 50 }, (_, i) => point(0, i * 0.0001, `t${i}`));
    const simplified = simplifyTrack(points, 6);
    expect(simplified.length).toBeLessThan(points.length);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[simplified.length - 1]).toEqual(points[points.length - 1]);
  });

  it('keeps a real turn (a point far from the start-end chord)', () => {
    const points = [
      point(0, 0, 't0'),
      point(0.01, 0, 't1'), // sharp turn away from the straight line
      point(0, 0.02, 't2'),
    ];
    const simplified = simplifyTrack(points, 6);
    expect(simplified).toHaveLength(3);
  });
});

describe('GeoJSON round trip', () => {
  it('encodes and decodes a track losslessly (within rounding)', () => {
    const points = [point(51.5, -0.1, 't0', 12.3), point(51.501, -0.099, 't1', 15.7)];
    const geojson = trackToGeoJsonLineString(points);
    const parsed = JSON.parse(geojson);
    expect(parsed.type).toBe('LineString');
    expect(parsed.coordinates).toHaveLength(2);

    const decoded = geoJsonLineStringToPoints(geojson);
    expect(decoded).toHaveLength(2);
    expect(decoded[0].latitude).toBeCloseTo(51.5, 4);
    expect(decoded[0].longitude).toBeCloseTo(-0.1, 4);
    expect(decoded[0].elevationM).toBeCloseTo(12.3, 1);
  });

  it('returns an empty array for malformed GeoJSON rather than throwing', () => {
    expect(geoJsonLineStringToPoints('not json')).toEqual([]);
    expect(geoJsonLineStringToPoints('{"type":"Point","coordinates":[0,0]}')).toEqual([]);
  });
});

describe('computeRollingSpeedMps', () => {
  it('returns null with fewer than 2 points', () => {
    expect(computeRollingSpeedMps([point(0, 0, '2026-01-01T00:00:00.000Z')])).toBeNull();
  });

  it('derives speed from points inside the trailing window', () => {
    const points = [
      point(0, 0, '2026-01-01T00:00:00.000Z'),
      point(0.0009, 0, '2026-01-01T00:00:30.000Z'),
      point(0.0018, 0, '2026-01-01T00:01:00.000Z'),
    ];
    const speed = computeRollingSpeedMps(points, 60);
    expect(speed).not.toBeNull();
    expect(speed!).toBeGreaterThan(3);
    expect(speed!).toBeLessThan(4);
  });

  it('excludes points older than the window', () => {
    const points = [
      point(0, 0, '2026-01-01T00:00:00.000Z'), // outside a 10s window
      point(0.0001, 0, '2026-01-01T00:00:55.000Z'),
      point(0.0002, 0, '2026-01-01T00:01:00.000Z'),
    ];
    const speed = computeRollingSpeedMps(points, 10);
    expect(speed).not.toBeNull();
  });
});

describe('normalizeSeries', () => {
  it('maps min..max to 0..1', () => {
    expect(normalizeSeries([100, 150, 200])).toEqual([0, 0.5, 1]);
  });

  it('returns a flat 0.5 baseline for a constant series rather than dividing by zero', () => {
    expect(normalizeSeries([50, 50, 50])).toEqual([0.5, 0.5, 0.5]);
  });

  it('returns an empty array for an empty series', () => {
    expect(normalizeSeries([])).toEqual([]);
  });
});

describe('computeBounds', () => {
  it('returns null for an empty track', () => {
    expect(computeBounds([])).toBeNull();
  });

  it('computes a bounding box across points', () => {
    const bounds = computeBounds([point(1, 2, 't0'), point(-1, 5, 't1'), point(0, -3, 't2')]);
    expect(bounds).toEqual({ minLat: -1, maxLat: 1, minLng: -3, maxLng: 5 });
  });
});
