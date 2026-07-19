import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { generateUuidV4 } from '../../lib/uuid';
import {
  computeBounds,
  computeRollingSpeedMps,
  computeTrackSummary,
  simplifyTrack,
  trackToGeoJsonLineString,
  type TrackPoint,
} from '../../lib/geo';
import { activityRepository } from '../../db/repositories/activityRepository';
import { activityRoutesRepository } from '../../db/repositories/activityRoutesRepository';
import { routePointsRepository } from '../../db/repositories/routePointsRepository';
import { recordingSessionRepository } from '../../db/repositories/recordingSessionRepository';
import { personalRecordsRepository } from '../../db/repositories/personalRecordsRepository';
import { activityAchievementsRepository } from '../../db/repositories/activityAchievementsRepository';
import { rpcTrackObjectPath } from '../../lib/activityTrackStorage';
import { runSync } from '../../sync/syncEngine';
import { elapsedSeconds, movingSeconds } from './recordingClock';
import { evaluateCandidates, type PrEvaluation } from './prEngine';
import type { ActivityType, GeoPoint, LocalRecordingSession, UnitDistanceSnapshot } from '../../db/types';
import type { GpsSignalState } from '../../components/activity/GpsSignal';

// GPS sampling — adjustable/reasonable, not maximum-frequency by default
// (mobile-architecture-standards: continuous high-frequency GPS is a known
// fast battery drain). 3s / 8m is a reasonable running/riding cadence.
const GPS_TIME_INTERVAL_MS = 3000;
const GPS_DISTANCE_INTERVAL_M = 8;
const GPS_ACCURACY = Location.LocationAccuracy.High; // "within ten meters" — not Highest/BestForNavigation
const GPS_LOST_TIMEOUT_MS = 15_000;
const GPS_STRONG_ACCURACY_M = 20;
const GPS_WEAK_ACCURACY_M = 50;
const UI_TICK_INTERVAL_MS = 1000;
const ROUTE_SIMPLIFY_TOLERANCE_M = 6;

export type FinishDraft = {
  activityTypeCode: string;
  activityTypeName: string;
  distanceM: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  averageSpeedMps: number | null;
  maxSpeedMps: number | null;
  movingTimeSeconds: number;
  durationSeconds: number;
  hasGpsRoute: boolean;
  occurredAt: string;
  suggestedTitle: string;
  /** Computed here (not just at confirmSave) so the Save sheet can preview the PrCallout before the user taps "Save activity" (design doc CORE-01 Save sheet spec). */
  prEvaluations: PrEvaluation[];
};

export type FinishSaveResult = { activityId: string; prEvaluations: PrEvaluation[] };

function toTrackPoint(p: GeoPoint): TrackPoint {
  return { latitude: p.latitude, longitude: p.longitude, elevationM: p.elevationM, accuracyM: p.accuracyM, recordedAt: p.recordedAt };
}

function suggestedTitle(typeName: string, occurredAt: Date): string {
  const hour = occurredAt.getHours();
  const timeOfDay = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  return `${timeOfDay} ${typeName}`;
}

export function useRecordingEngine(params: { userId: string; unitDistance: UnitDistanceSnapshot }) {
  const { userId, unitDistance } = params;

  const [loading, setLoading] = useState(true);
  const [crashRecoverySession, setCrashRecoverySession] = useState<LocalRecordingSession | null>(null);
  const [session, setSession] = useState<LocalRecordingSession | null>(null);
  const [selectedType, setSelectedType] = useState<ActivityType | null>(null);
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [gpsSignal, setGpsSignal] = useState<GpsSignalState>('acquiring');
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const lastFixAtRef = useRef<number | null>(null);
  const pointsRef = useRef<GeoPoint[]>([]);

  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  // Crash-recovery check on mount (design doc CORE-01: "an in-progress
  // recording is layer-2 local state ... on relaunch offer a resume prompt").
  useEffect(() => {
    let mounted = true;
    (async () => {
      const active = await recordingSessionRepository.getActiveForUser(userId);
      if (!mounted) return;
      if (active) {
        setCrashRecoverySession(active);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [userId]);

  // UI clock tick — every second, so the hero MetricStat updates even
  // between GPS fixes (moving/elapsed time are wall-clock derived, not
  // GPS-derived).
  useEffect(() => {
    if (!session || session.status !== 'recording') return;
    const interval = setInterval(() => setTick((t) => t + 1), UI_TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session]);

  // GPS-lost detection: if no fix has arrived for GPS_LOST_TIMEOUT_MS while
  // actively recording, degrade the signal chip honestly rather than
  // leaving a stale "Strong".
  useEffect(() => {
    if (!session || session.status !== 'recording' || session.locationDeclined) return;
    const interval = setInterval(() => {
      const last = lastFixAtRef.current;
      if (last != null && Date.now() - last > GPS_LOST_TIMEOUT_MS) {
        setGpsSignal('lost');
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [session]);

  useEffect(() => {
    if (session?.status === 'recording') {
      void activateKeepAwakeAsync('milelift-recording');
    } else {
      void deactivateKeepAwake('milelift-recording');
    }
    return () => void deactivateKeepAwake('milelift-recording');
  }, [session?.status]);

  const stopWatch = useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
  }, []);

  const startWatch = useCallback(async (sessionId: string) => {
    stopWatch();
    const sub = await Location.watchPositionAsync(
      { accuracy: GPS_ACCURACY, timeInterval: GPS_TIME_INTERVAL_MS, distanceInterval: GPS_DISTANCE_INTERVAL_M },
      (locationUpdate) => {
        lastFixAtRef.current = Date.now();
        const accuracy = locationUpdate.coords.accuracy ?? null;
        setGpsSignal(accuracy != null && accuracy <= GPS_STRONG_ACCURACY_M ? 'strong' : accuracy != null && accuracy <= GPS_WEAK_ACCURACY_M ? 'weak' : 'weak');

        const point: GeoPoint = {
          latitude: locationUpdate.coords.latitude,
          longitude: locationUpdate.coords.longitude,
          elevationM: locationUpdate.coords.altitude ?? null,
          accuracyM: accuracy,
          recordedAt: new Date(locationUpdate.timestamp).toISOString(),
          isMoving: true,
        };

        void routePointsRepository.append(sessionId, point);
        setPoints((prev) => [...prev, point]);
      },
      (err) => {
        // A watch error must not crash the recording — degrade to "Lost" and
        // keep the clock running (design doc CORE-01 unhappy path).
        setGpsSignal('lost');
        console.warn('Location watch error during recording:', err);
      }
    );
    watchRef.current = sub;
  }, [stopWatch]);

  useEffect(() => stopWatch, [stopWatch]);

  const start = useCallback(
    async (withLocation: boolean) => {
      if (!selectedType) return;
      const id = generateUuidV4();
      const created = await recordingSessionRepository.start(id, userId, selectedType.code, !withLocation);
      setSession(created);
      setPoints([]);
      setGpsSignal(withLocation ? 'acquiring' : 'lost');
      lastFixAtRef.current = null;
      if (withLocation && selectedType.supportsGps) {
        await startWatch(id);
      }
    },
    [selectedType, userId, startWatch]
  );

  const pause = useCallback(async () => {
    if (!session) return;
    stopWatch();
    const updated = await recordingSessionRepository.pause(session.id);
    setSession(updated);
  }, [session, stopWatch]);

  const resume = useCallback(async () => {
    if (!session) return;
    const updated = await recordingSessionRepository.resume(session.id);
    setSession(updated);
    if (!session.locationDeclined && selectedType?.supportsGps) {
      await startWatch(session.id);
    }
  }, [session, selectedType, startWatch]);

  const discard = useCallback(async () => {
    if (!session) return;
    stopWatch();
    await routePointsRepository.clear(session.id);
    await recordingSessionRepository.clear(session.id);
    setSession(null);
    setPoints([]);
  }, [session, stopWatch]);

  const resumeCrashRecovery = useCallback(async () => {
    if (!crashRecoverySession) return;
    const restoredPoints = await routePointsRepository.getAll(crashRecoverySession.id);
    const type = crashRecoverySession.activityTypeCode;
    setPoints(restoredPoints);
    setSession(crashRecoverySession);
    setCrashRecoverySession(null);
    if (!crashRecoverySession.locationDeclined && crashRecoverySession.status === 'recording') {
      await startWatch(crashRecoverySession.id);
    }
    return type;
  }, [crashRecoverySession, startWatch]);

  const discardCrashRecovery = useCallback(async () => {
    if (!crashRecoverySession) return;
    await routePointsRepository.clear(crashRecoverySession.id);
    await recordingSessionRepository.clear(crashRecoverySession.id);
    setCrashRecoverySession(null);
  }, [crashRecoverySession]);

  const prepareFinish = useCallback(async (): Promise<FinishDraft | null> => {
    if (!session || !selectedType) return null;
    stopWatch();
    const now = new Date();
    const currentPoints = pointsRef.current;
    const hasGpsRoute = !session.locationDeclined && selectedType.supportsGps && currentPoints.length >= 2;
    const summary = hasGpsRoute ? computeTrackSummary(currentPoints.map(toTrackPoint)) : null;
    const moving = Math.round(movingSeconds(session, now));
    const elapsed = Math.round(elapsedSeconds(session, now));
    const startedAtDate = new Date(session.startedAt);

    // Only ever a real number when a GPS summary actually exists — a
    // distance-based type recorded without GPS (declined location, or a
    // `supports_gps = false` type like an indoor trainer) has genuinely NO
    // distance data, and must stay NULL rather than a misleading "0"
    // (design doc: a no-route activity is "has_gps_route = false,
    // distance_m NULL", never a fabricated zero).
    const distanceM = selectedType.isDistanceBased ? (summary?.distanceM ?? null) : null;
    const elevationGainM = selectedType.tracksElevation ? (summary?.elevationGainM ?? null) : null;
    const averageSpeedMps = selectedType.isDistanceBased && summary && moving > 0 ? summary.distanceM / moving : null;
    const durationSeconds = Math.max(moving, elapsed);

    // Optimistic PR preview (design doc CORE-01/04): compute against the
    // local cache now, so the Save sheet can show the PrCallout before the
    // activity is even persisted. `confirmSave` reuses this exact array
    // rather than recomputing, so what's shown and what's saved never drift.
    const cache = await personalRecordsRepository.getForType(userId, selectedType.code);
    const prEvaluations = evaluateCandidates(
      { durationSeconds, distanceM, averageSpeedMps, elevationGainM },
      { isDistanceBased: selectedType.isDistanceBased, tracksElevation: selectedType.tracksElevation },
      new Map(Array.from(cache.entries()).map(([metric, record]) => [metric, { value: record.value }]))
    );

    return {
      activityTypeCode: selectedType.code,
      activityTypeName: selectedType.displayName,
      distanceM,
      elevationGainM,
      elevationLossM: selectedType.tracksElevation ? (summary?.elevationLossM ?? null) : null,
      averageSpeedMps,
      maxSpeedMps: summary?.maxSpeedMps ?? null,
      movingTimeSeconds: moving,
      durationSeconds,
      hasGpsRoute,
      occurredAt: session.startedAt,
      suggestedTitle: suggestedTitle(selectedType.displayName, startedAtDate),
      prEvaluations,
    };
  }, [session, selectedType, stopWatch, userId]);

  const confirmSave = useCallback(
    async (draft: FinishDraft, title: string, description: string | null): Promise<FinishSaveResult> => {
      if (!session || !selectedType) throw new Error('No active recording session to save.');
      setSaving(true);
      try {
        const activityId = session.id;
        const nowIso = new Date().toISOString();
        const localDate = draft.occurredAt.slice(0, 10);

        await activityRepository.upsertLocal(activityId, userId, {
          activityTypeCode: draft.activityTypeCode,
          activityTypeNameSnapshot: draft.activityTypeName,
          title,
          description,
          occurredAt: draft.occurredAt,
          localDate,
          eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          durationSeconds: draft.durationSeconds,
          movingTimeSeconds: draft.movingTimeSeconds,
          distanceM: draft.distanceM,
          unitDistanceSnapshot: unitDistance,
          elevationGainM: draft.elevationGainM,
          elevationLossM: draft.elevationLossM,
          averageSpeedMps: draft.averageSpeedMps,
          maxSpeedMps: draft.maxSpeedMps,
          hasGpsRoute: draft.hasGpsRoute,
          // No calorie estimation is implemented in Phase 1 mobile — that
          // needs bodyweight + consent-gated MET-based estimation (a
          // separate, non-trivial feature). Left NULL/'none', matching the
          // same "no estimate fallback" discipline architecture §12.7 uses
          // for the Health Connect write-back path. Flagged as follow-up.
          energyKcal: null,
          caloriesSource: 'none',
          source: 'manual',
          visibility: 'private',
          clientCreatedAt: nowIso,
        });

        if (draft.hasGpsRoute) {
          const currentPoints = pointsRef.current.map(toTrackPoint);
          const simplified = simplifyTrack(currentPoints, ROUTE_SIMPLIFY_TOLERANCE_M);
          const geojson = trackToGeoJsonLineString(simplified);
          const bounds = computeBounds(currentPoints);
          await activityRoutesRepository.save({
            activityId,
            simplifiedGeojson: geojson,
            boundsJson: bounds ? JSON.stringify(bounds) : null,
            rawTrackObjectPath: rpcTrackObjectPath(userId, activityId),
            rawPointCount: currentPoints.length,
            simplifiedPointCount: simplified.length,
          });
        }

        // Optimistic PR celebration (design doc CORE-04): the exact
        // evaluations already computed (and shown) in `prepareFinish` —
        // reused, not recomputed, so what the Save sheet previewed and what
        // gets written can never drift. Reconciled against the server's
        // authoritative response once this activity syncs
        // (src/sync/activitySync.ts#reconcilePrs).
        const evaluations = draft.prEvaluations;
        if (evaluations.length > 0) {
          await personalRecordsRepository.applyOptimistic(userId, draft.activityTypeCode, activityId, draft.occurredAt, unitDistance, evaluations);
          await activityAchievementsRepository.applyOptimistic(activityId, userId, evaluations);
        }

        await recordingSessionRepository.clear(session.id);
        setSession(null);
        setPoints([]);

        void runSync('post-write');

        return { activityId, prEvaluations: evaluations };
      } finally {
        setSaving(false);
      }
    },
    [session, selectedType, userId, unitDistance]
  );

  const currentPaceMps = useMemo(() => computeRollingSpeedMps(points.map(toTrackPoint)), [points]);

  const now = useMemo(() => new Date(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveElapsedSeconds = session ? elapsedSeconds(session, now) : 0;
  const liveMovingSeconds = session ? movingSeconds(session, now) : 0;
  const liveSummary = useMemo(() => (points.length >= 2 ? computeTrackSummary(points.map(toTrackPoint)) : null), [points]);

  return {
    loading,
    crashRecoverySession,
    resumeCrashRecovery,
    discardCrashRecovery,

    session,
    status: session ? session.status : ('ready' as const),
    selectedType,
    setSelectedType,

    points,
    gpsSignal,
    liveElapsedSeconds,
    liveMovingSeconds,
    liveDistanceM: liveSummary?.distanceM ?? 0,
    liveElevationGainM: liveSummary?.elevationGainM ?? null,
    currentPaceMps,

    start,
    pause,
    resume,
    discard,
    prepareFinish,
    confirmSave,
    saving,
  };
}
