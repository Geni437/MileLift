import { Platform } from 'react-native';

import { activityTypeToHealthConnectExerciseType, healthConnectExerciseTypeToActivityType } from './exerciseTypeMap';

/**
 * Thin wrapper around `react-native-health-connect` (CORE-03, architecture
 * §3). Isolated in its own module so:
 *   1. every other file imports types/functions from HERE, not the native
 *      package directly — one place to swap/mock the SDK,
 *   2. Android-only gating (design doc CORE-03: "iOS ... Health Connect is
 *      Android-only") lives in one place, not scattered `Platform.OS`
 *      checks.
 *
 * NOT LIVE-DEVICE-TESTED (flagged, not silently claimed otherwise): this
 * repo has no attached Android device/emulator in this environment. The
 * code is written against the real `react-native-health-connect` v3.5.3
 * API surface (verified against its shipped .d.ts files), but the actual
 * OS permission dialog, read/write round-trip, and loop-prevention behavior
 * need a real on-device smoke test before this is considered verified.
 */

export type HealthConnectAvailability = 'available' | 'unavailable' | 'update_required' | 'not_android';

export type ImportedSession = {
  externalRecordId: string;
  dataOriginPackageName: string | null;
  activityTypeCode: string;
  title: string | null;
  startTime: string;
  endTime: string;
  distanceMeters: number | null;
  totalCalories: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
};

export type WriteBackInput = {
  activityTypeCode: string;
  title: string;
  startTime: string; // ISO
  endTime: string; // ISO
  distanceMeters: number | null;
  totalCaloriesKcal: number | null; // magnitude, not signed
};

async function loadNativeModule() {
  // Deferred require so this module can be imported (and its pure exports
  // used, e.g. for tests) even in environments/builds where the native
  // Health Connect module isn't linked (iOS, web, this repo's Jest run).
  return import('react-native-health-connect');
}

export function getAvailabilityPlatformGate(): 'android' | 'not_android' {
  return Platform.OS === 'android' ? 'android' : 'not_android';
}

export const healthConnectClient = {
  async checkAvailability(): Promise<HealthConnectAvailability> {
    if (Platform.OS !== 'android') return 'not_android';
    const hc = await loadNativeModule();
    const status = await hc.getSdkStatus();
    if (status === hc.SdkAvailabilityStatus.SDK_AVAILABLE) return 'available';
    if (status === hc.SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) return 'update_required';
    return 'unavailable';
  },

  async initialize(): Promise<boolean> {
    const hc = await loadNativeModule();
    return hc.initialize();
  },

  /**
   * Requests only the minimum types the current feature needs
   * (health-data-compliance: "request only what the current feature
   * needs") — session + distance + calories for read; the same set plus
   * write for write-back. HeartRate read is included because architecture
   * §3.1 maps `average_hr`/`max_hr` from an associated `HeartRateRecord`
   * "if present and consented" — gated separately by the app's own
   * `health` consent category before any value is actually stored.
   */
  async requestPermissions(includeWrite: boolean): Promise<boolean> {
    const hc = await loadNativeModule();
    const permissions: { accessType: 'read' | 'write'; recordType: string }[] = [
      { accessType: 'read', recordType: 'ExerciseSession' },
      { accessType: 'read', recordType: 'Distance' },
      { accessType: 'read', recordType: 'TotalCaloriesBurned' },
      { accessType: 'read', recordType: 'HeartRate' },
    ];
    if (includeWrite) {
      permissions.push(
        { accessType: 'write', recordType: 'ExerciseSession' },
        { accessType: 'write', recordType: 'Distance' },
        { accessType: 'write', recordType: 'TotalCaloriesBurned' }
      );
    }
    const granted = await hc.requestPermission(permissions as Parameters<typeof hc.requestPermission>[0]);
    // Session read+write are the load-bearing permissions; distance/
    // calories/HR enrich but their absence shouldn't block the connect flow.
    return granted.some((p) => p.recordType === 'ExerciseSession');
  },

  /**
   * Reads exercise sessions in a time range and joins in Distance/
   * TotalCaloriesBurned/HeartRate records that overlap each session
   * (architecture §3.1). Never throws for a session missing an associated
   * record — those fields are simply null.
   */
  async readSessions(sinceIso: string): Promise<ImportedSession[]> {
    const hc = await loadNativeModule();
    const timeRangeFilter = { operator: 'after' as const, startTime: sinceIso };

    const [sessions, distances, calories, heartRates] = await Promise.all([
      hc.readRecords('ExerciseSession', { timeRangeFilter }),
      hc.readRecords('Distance', { timeRangeFilter }).catch(() => ({ records: [] })),
      hc.readRecords('TotalCaloriesBurned', { timeRangeFilter }).catch(() => ({ records: [] })),
      hc.readRecords('HeartRate', { timeRangeFilter }).catch(() => ({ records: [] })),
    ]);

    return sessions.records.map((session) => {
      const overlappingDistance = distances.records.find((d) => overlaps(d.startTime, d.endTime, session.startTime, session.endTime));
      const overlappingCalories = calories.records.find((c) => overlaps(c.startTime, c.endTime, session.startTime, session.endTime));
      const overlappingHr = heartRates.records.filter((h) => overlaps(h.startTime, h.endTime, session.startTime, session.endTime));
      const hrSamples = overlappingHr.flatMap((h) => h.samples.map((s) => s.beatsPerMinute));

      return {
        externalRecordId: session.metadata?.id ?? `${session.startTime}-${session.endTime}`,
        dataOriginPackageName: session.metadata?.dataOrigin ?? null,
        activityTypeCode: healthConnectExerciseTypeToActivityType(session.exerciseType),
        title: session.title ?? null,
        startTime: session.startTime,
        endTime: session.endTime,
        distanceMeters: overlappingDistance?.distance.inMeters ?? null,
        totalCalories: overlappingCalories?.energy.inKilocalories ?? null,
        averageHeartRateBpm: hrSamples.length > 0 ? hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length : null,
        maxHeartRateBpm: hrSamples.length > 0 ? Math.max(...hrSamples) : null,
      };
    });
  },

  /**
   * Write-back: session + distance + energy ONLY, never the route
   * (architecture §3.2/§12 item 7: "Recommended Phase 1 write-back payload:
   * session + distance + energy, NOT the GPS route"). Returns the Health
   * Connect record id, which the caller records in `wearable_links`
   * (`direction = 'outbound'`) for loop-prevention.
   */
  async writeBackSession(input: WriteBackInput): Promise<string> {
    const hc = await loadNativeModule();
    const records: Parameters<typeof hc.insertRecords>[0] = [
      {
        recordType: 'ExerciseSession',
        exerciseType: activityTypeToHealthConnectExerciseType(input.activityTypeCode),
        title: input.title,
        startTime: input.startTime,
        endTime: input.endTime,
      },
    ];
    if (input.distanceMeters != null) {
      records.push({
        recordType: 'Distance',
        startTime: input.startTime,
        endTime: input.endTime,
        distance: { value: input.distanceMeters, unit: 'meters' },
      });
    }
    if (input.totalCaloriesKcal != null) {
      records.push({
        recordType: 'TotalCaloriesBurned',
        startTime: input.startTime,
        endTime: input.endTime,
        energy: { value: input.totalCaloriesKcal, unit: 'kilocalories' },
      });
    }

    const ids = await hc.insertRecords(records);
    return ids[0];
  },

  openSettings: async () => {
    const hc = await loadNativeModule();
    hc.openHealthConnectSettings();
  },
};

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() && new Date(bStart).getTime() < new Date(aEnd).getTime();
}
