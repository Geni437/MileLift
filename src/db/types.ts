export type SyncStatus = 'synced' | 'pending' | 'failed';

export type UnitWeight = 'kg' | 'lb';
export type UnitDistance = 'km' | 'mi';

export type LocalProfile = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  unitWeight: UnitWeight;
  unitDistance: UnitDistance;
  defaultTimezone: string;
  deletionRequestedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

/** Fields the client is allowed to write (matches the `profiles` GRANT UPDATE column list). */
export type ProfileWritableFields = Partial<{
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  unitWeight: UnitWeight;
  unitDistance: UnitDistance;
  defaultTimezone: string;
  deletionRequestedAt: string | null;
}>;

export type ConsentCategory = 'health' | 'location' | 'camera';

export type LocalConsent = {
  id: string;
  userId: string;
  category: ConsentCategory;
  purposeVersion: string;
  grantedAt: string;
  revokedAt: string | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type Sex = 'female' | 'male' | 'intersex' | 'other' | 'prefer_not_to_say';

export type LocalProfileHealth = {
  userId: string;
  sex: Sex | null;
  dateOfBirth: string | null; // ISO date (YYYY-MM-DD)
  heightCm: number | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type ProfileHealthWritableFields = Partial<{
  sex: Sex | null;
  dateOfBirth: string | null;
  heightCm: number | null;
}>;

// ---------------------------------------------------------------------------
// Phase 1 — Module A (activity & movement tracking)
// ---------------------------------------------------------------------------

/** `activity_types` catalog metadata (architecture §1.1). */
export type ActivityCategory = 'foot' | 'cycle' | 'water' | 'winter' | 'gym_cardio' | 'other';

export type ActivityType = {
  code: string;
  displayName: string;
  category: ActivityCategory;
  isDistanceBased: boolean;
  tracksElevation: boolean;
  supportsGps: boolean;
  sortOrder: number;
};

export type ActivitySource = 'manual' | 'wearable' | 'import';
export type ActivityVisibility = 'private' | 'followers' | 'public';
export type CaloriesSource = 'estimated' | 'wearable' | 'manual' | 'none';
export type UnitDistanceSnapshot = 'km' | 'mi';

/** One row of the local `activities` table — spine + activity_details merged (see schema.ts note). */
export type LocalActivity = {
  id: string;
  userId: string;
  activityTypeCode: string;
  activityTypeNameSnapshot: string;
  title: string | null;
  description: string | null;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  durationSeconds: number;
  movingTimeSeconds: number | null;
  distanceM: number | null;
  unitDistanceSnapshot: UnitDistanceSnapshot;
  elevationGainM: number | null;
  elevationLossM: number | null;
  averageSpeedMps: number | null;
  maxSpeedMps: number | null;
  averageHr: number | null;
  maxHr: number | null;
  hasGpsRoute: boolean;
  energyKcal: number | null;
  caloriesSource: CaloriesSource;
  source: ActivitySource;
  visibility: ActivityVisibility;
  clientCreatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  kudosCount: number;
  kudosCountFetchedAt: string | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

/** Fields the recording/edit flow writes locally before a `save_activity_v1` call. */
export type ActivityWritableFields = {
  activityTypeCode: string;
  activityTypeNameSnapshot: string;
  title?: string | null;
  description?: string | null;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  durationSeconds: number;
  movingTimeSeconds?: number | null;
  distanceM?: number | null;
  unitDistanceSnapshot: UnitDistanceSnapshot;
  elevationGainM?: number | null;
  elevationLossM?: number | null;
  averageSpeedMps?: number | null;
  maxSpeedMps?: number | null;
  averageHr?: number | null;
  maxHr?: number | null;
  hasGpsRoute: boolean;
  energyKcal?: number | null;
  caloriesSource: CaloriesSource;
  source: ActivitySource;
  visibility?: ActivityVisibility;
  clientCreatedAt?: string | null;
};

export type RouteUploadStatus = 'pending' | 'uploaded' | 'failed';

export type LocalActivityRoute = {
  activityId: string;
  simplifiedGeojson: string; // GeoJSON LineString text, coords [lng,lat,elevation]
  boundsJson: string | null;
  rawTrackObjectPath: string;
  rawTrackChecksum: string | null;
  rawPointCount: number | null;
  simplifiedPointCount: number | null;
  rawTrackUploadStatus: RouteUploadStatus;
};

export type GeoPoint = {
  latitude: number;
  longitude: number;
  elevationM: number | null;
  accuracyM: number | null;
  recordedAt: string; // ISO
  isMoving: boolean;
};

export type RecordingStatus = 'recording' | 'paused';

export type LocalRecordingSession = {
  id: string;
  userId: string;
  activityTypeCode: string;
  status: RecordingStatus;
  startedAt: string;
  lastResumedAt: string;
  accumulatedMovingSeconds: number;
  locationDeclined: boolean;
  updatedAt: string;
};

export type PrMetric = 'longest_distance' | 'fastest_avg_pace' | 'most_elevation_gain' | 'longest_duration';

export type LocalPersonalRecord = {
  userId: string;
  activityTypeCode: string;
  metric: PrMetric;
  value: number;
  unitSnapshot: string | null;
  timelineEventId: string;
  achievedAt: string;
  previousValue: number | null;
  confirmed: boolean;
};

export type AchievementRank = 'pr' | 'second' | 'third';

export type LocalAchievement = {
  id: string;
  timelineEventId: string;
  userId: string;
  metric: PrMetric;
  value: number;
  rank: AchievementRank | null;
  isOptimistic: boolean;
};

export type WearableProvider = 'health_connect' | 'wear_os' | 'garmin' | 'apple_health';
export type WearableLinkDirection = 'inbound' | 'outbound';

export type LocalWearableLink = {
  id: string;
  timelineEventId: string;
  userId: string;
  provider: WearableProvider;
  direction: WearableLinkDirection;
  externalRecordId: string;
  syncedAt: string;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type LocalHealthConnectState = {
  userId: string;
  connected: boolean;
  writeBackEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};
