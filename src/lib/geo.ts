/**
 * Pure GPS-track math: distance, elevation, path simplification, GeoJSON
 * encoding. No React Native / expo-location imports here on purpose — this
 * module is unit-testable in plain Node (test-strategy: business logic gets
 * a real test, not "I tested it manually once").
 *
 * Design ref: docs/architecture/phase-1-module-a.md §2 (two-tier GPS
 * storage: full-res stays local until finish; a simplified path is what
 * ships to `activity_routes`).
 */

export type TrackPoint = {
  latitude: number;
  longitude: number;
  elevationM: number | null;
  accuracyM: number | null;
  recordedAt: string; // ISO 8601
};

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two points, in meters (haversine). */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

// A generous speed ceiling used only to reject an implausible GPS
// spike/multipath jump from corrupting the whole activity's distance total
// (production-standards: validate malformed input at the boundary, don't
// let one bad fix corrupt the record). ~200 km/h comfortably covers every
// activity type this catalog supports, including downhill skiing/cycling —
// it exists to catch GPS glitches, not to police real speed.
const IMPLAUSIBLE_SPEED_MPS = 55;

// Sub-meter GPS elevation readings are noise, not real ascent/descent.
const ELEVATION_NOISE_THRESHOLD_M = 1;

export type TrackSummary = {
  distanceM: number;
  elevationGainM: number | null;
  elevationLossM: number | null;
  maxSpeedMps: number | null;
};

/**
 * Summary stats computed ONCE from the full-resolution local track, per
 * architecture §2.1 ("Summary stats ... computed once at finish ... never
 * recomputed on read"). Moving/elapsed TIME are deliberately NOT computed
 * here — those come from the recording session's own start/pause/resume
 * timestamps (see recordingSessionRepository), independent of GPS sampling.
 */
export function computeTrackSummary(points: TrackPoint[]): TrackSummary {
  if (points.length < 2) {
    const hasElevation = points.some((p) => p.elevationM != null);
    return {
      distanceM: 0,
      elevationGainM: hasElevation ? 0 : null,
      elevationLossM: hasElevation ? 0 : null,
      maxSpeedMps: null,
    };
  }

  let distanceM = 0;
  let gain = 0;
  let loss = 0;
  let hasElevation = false;
  let maxSpeed = 0;
  let hasValidSpeed = false;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const segmentDistanceM = haversineMeters(prev, curr);
    const dtSeconds = (new Date(curr.recordedAt).getTime() - new Date(prev.recordedAt).getTime()) / 1000;

    if (dtSeconds > 0 && segmentDistanceM / dtSeconds > IMPLAUSIBLE_SPEED_MPS) {
      // Reject this segment entirely (both from distance and speed) — a
      // single bad fix must not inflate the recorded distance.
      continue;
    }

    distanceM += segmentDistanceM;

    if (dtSeconds > 0) {
      const speedMps = segmentDistanceM / dtSeconds;
      if (speedMps > maxSpeed) maxSpeed = speedMps;
      hasValidSpeed = true;
    }

    if (prev.elevationM != null && curr.elevationM != null) {
      hasElevation = true;
      const delta = curr.elevationM - prev.elevationM;
      if (Math.abs(delta) >= ELEVATION_NOISE_THRESHOLD_M) {
        if (delta > 0) gain += delta;
        else loss += Math.abs(delta);
      }
    }
  }

  return {
    distanceM,
    elevationGainM: hasElevation ? gain : null,
    elevationLossM: hasElevation ? loss : null,
    maxSpeedMps: hasValidSpeed ? maxSpeed : null,
  };
}

/** Local equirectangular-projection meters, adequate at single-activity scale. */
function toLocalXY(point: { latitude: number; longitude: number }, origin: { latitude: number; longitude: number }) {
  const latRad = (origin.latitude * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(latRad);
  return {
    x: (point.longitude - origin.longitude) * mPerDegLng,
    y: (point.latitude - origin.latitude) * mPerDegLat,
  };
}

function perpendicularDistanceMeters(point: TrackPoint, lineStart: TrackPoint, lineEnd: TrackPoint): number {
  const p = toLocalXY(point, lineStart);
  const b = toLocalXY(lineEnd, lineStart);
  const lengthSq = b.x * b.x + b.y * b.y;
  if (lengthSq === 0) return Math.hypot(p.x, p.y);
  const t = Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / lengthSq));
  const projX = t * b.x;
  const projY = t * b.y;
  return Math.hypot(p.x - projX, p.y - projY);
}

const DEFAULT_SIMPLIFY_TOLERANCE_M = 6;

/**
 * Douglas-Peucker path simplification (iterative, explicit stack — not
 * recursive, so a multi-hour recording with tens of thousands of points
 * can't blow the JS call stack on a pathological/near-monotonic track).
 * This is what turns the full-res local track into `activity_routes`'
 * `simplified_path` on finish (architecture §2.1).
 */
export function simplifyTrack(points: TrackPoint[], toleranceMeters = DEFAULT_SIMPLIFY_TOLERANCE_M): TrackPoint[] {
  if (points.length <= 2) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;

    let maxDist = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceMeters(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }

    if (maxIndex !== -1 && maxDist > toleranceMeters) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** GeoJSON `LineString` text, coords `[lng, lat, elevation?]` — the exact `p_route_geojson` shape (docs/api/save-activity-v1.md §2.2). */
export function trackToGeoJsonLineString(points: TrackPoint[]): string {
  const coordinates = points.map((p) => {
    const coord: number[] = [round(p.longitude, 6), round(p.latitude, 6)];
    if (p.elevationM != null) coord.push(round(p.elevationM, 1));
    return coord;
  });
  return JSON.stringify({ type: 'LineString', coordinates });
}

export type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

/** Bounding box for camera-fit (RouteMap) and feed thumbnails — local equivalent of `ST_Envelope`. */
export function computeBounds(points: TrackPoint[]): Bounds | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  return { minLat, maxLat, minLng, maxLng };
}

const DEFAULT_ROLLING_PACE_WINDOW_SECONDS = 60;

/**
 * Live "current pace" — a rolling on-device derivation over the trailing
 * window of GPS samples (design doc CORE-01: "current pace is a rolling
 * on-device derivation from recent GPS and is NOT persisted"). Returns
 * `null` when there isn't enough recent data yet, never a divide-by-zero.
 */
export function computeRollingSpeedMps(points: TrackPoint[], windowSeconds = DEFAULT_ROLLING_PACE_WINDOW_SECONDS): number | null {
  if (points.length < 2) return null;
  const lastTime = new Date(points[points.length - 1].recordedAt).getTime();
  const windowPoints = points.filter((p) => lastTime - new Date(p.recordedAt).getTime() <= windowSeconds * 1000);
  if (windowPoints.length < 2) return null;

  const summary = computeTrackSummary(windowPoints);
  const dtSeconds = (lastTime - new Date(windowPoints[0].recordedAt).getTime()) / 1000;
  if (dtSeconds <= 0) return null;
  return summary.distanceM / dtSeconds;
}

/**
 * Normalizes a raw value series (e.g. elevation in meters) to 0..1 for
 * `MeridianTrace`'s undulation prop, which expects a normalized series, not
 * raw units. A flat series (all-equal values, e.g. no real elevation
 * change, or a single point) normalizes to a flat 0.5 baseline rather than
 * dividing by a zero range.
 */
export function normalizeSeries(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

/** Parses the GeoJSON text this module writes, for map rendering. Returns `[]` on malformed/legacy data rather than throwing (never crash a detail screen on bad cached data). */
export function geoJsonLineStringToPoints(
  geojson: string
): { latitude: number; longitude: number; elevationM: number | null }[] {
  try {
    const parsed = JSON.parse(geojson) as { type?: string; coordinates?: number[][] };
    if (parsed.type !== 'LineString' || !Array.isArray(parsed.coordinates)) return [];
    return parsed.coordinates
      .filter((c): c is number[] => Array.isArray(c) && c.length >= 2)
      .map((c) => ({ longitude: c[0], latitude: c[1], elevationM: c.length >= 3 ? c[2] : null }));
  } catch {
    return [];
  }
}
