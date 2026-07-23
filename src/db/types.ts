/**
 * `local` — Phase 2 addition (screens-phase-2.md CORE-17): a record that is
 * durable in local SQLite but has not yet been enqueued for a sync push at
 * all (an in-progress workout, before Finish). Distinct from `pending`
 * ("saved and queued to sync") — see workoutSessionsRepository/useWorkoutEngine.
 */
export type SyncStatus = 'synced' | 'pending' | 'failed' | 'local';

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

export type ConsentCategory = 'health' | 'location' | 'camera' | 'body_image';

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

// ---------------------------------------------------------------------------
// Phase 2 — Module C (strength training & workout logging). Design ref:
// docs/architecture/phase-2-module-c.md, docs/api/save-workout-session-v1.md,
// docs/design/screens-phase-2.md.
// ---------------------------------------------------------------------------

export type MuscleGroup =
  | 'chest' | 'back' | 'lats' | 'traps' | 'shoulders' | 'biceps' | 'triceps' | 'forearms'
  | 'abs' | 'obliques' | 'quadriceps' | 'hamstrings' | 'glutes' | 'calves'
  | 'adductors' | 'abductors' | 'neck' | 'full_body' | 'cardio';

export type EquipmentType = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'kettlebell' | 'band' | 'other';
export type ExerciseMechanic = 'compound' | 'isolation';
export type ExerciseForceVector = 'push' | 'pull' | 'static';
export type SourceDataset = 'free_exercise_db' | 'wger' | 'milelift_authored';
export type ExerciseMediaType = 'image' | 'animation' | 'video';

/** Read-only local cache of the global `exercises` library (architecture §9.1). */
export type LocalExercise = {
  id: string;
  slug: string;
  name: string;
  primaryMuscle: MuscleGroup;
  secondaryMuscles: MuscleGroup[];
  equipment: EquipmentType;
  mechanic: ExerciseMechanic | null;
  forceVector: ExerciseForceVector | null;
  isDistanceBased: boolean;
  isTimeBased: boolean;
  isWeighted: boolean;
  isBodyweight: boolean;
  instructions: string | null;
  source: SourceDataset;
  attribution: string | null;
  isActive: boolean;
};

export type LocalExerciseMedia = {
  id: string;
  exerciseId: string;
  mediaType: ExerciseMediaType;
  urlOrObjectPath: string;
  isPrimary: boolean;
  source: SourceDataset;
  attribution: string | null;
  license: string | null;
  sortOrder: number;
};

/** A movement's metadata-driven field set (architecture §1.1/§1.5, design §A "SetRow"). */
export type ExerciseFieldFlags = {
  isDistanceBased: boolean;
  isTimeBased: boolean;
  isWeighted: boolean;
  isBodyweight: boolean;
};

export type LocalCustomExercise = {
  id: string;
  userId: string;
  name: string;
  primaryMuscle: MuscleGroup | null;
  equipment: EquipmentType | null;
  isWeighted: boolean;
  isBodyweight: boolean;
  isTimeBased: boolean;
  isDistanceBased: boolean;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Has this row's id ever been confirmed by a successful server INSERT (first-create vs. edit for the push side). */
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type WorkoutSetType = 'working' | 'warmup' | 'dropset' | 'failure' | 'amrap';
export type UnitWeightSnapshot = 'kg' | 'lb';

/** One row of the local `workout_set_logs` mirror — the CORE-12 firehose (architecture §1.5, §9.2). */
export type LocalWorkoutSet = {
  id: string;
  timelineEventId: string;
  userId: string;
  exerciseId: string | null;
  customExerciseId: string | null;
  exerciseNameSnapshot: string;
  primaryMuscleSnapshot: MuscleGroup | null;
  exerciseOrder: number;
  setNumber: number;
  setType: WorkoutSetType;
  reps: number | null;
  weightKg: number | null;
  unitWeightSnapshot: UnitWeightSnapshot;
  isBodyweight: boolean;
  durationSeconds: number | null;
  distanceM: number | null;
  rpe: number | null;
  restSecondsPlanned: number | null;
  restSecondsActual: number | null;
  isCompleted: boolean;
  estimated1rmKg: number | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Has this row changed locally since it was last confirmed synced (§9.2 per-set idempotency grain). */
  dirty: boolean;
  /** Has this exact set `id` ever been included in a successful `save_workout_session_v1` response. */
  serverConfirmed: boolean;
};

export type WorkoutSource = 'manual' | 'wearable' | 'import';
export type WorkoutVisibility = 'private' | 'followers' | 'public';

/**
 * One row of the local `workout_sessions` mirror — spine (timeline_events)
 * fields + session fields merged, same simplification `activities` uses for
 * Module A (schema.ts header) since Module C is the second concrete event
 * type this client stores, not a generic timeline_events join (Phase 0 §3.2).
 *
 * `isFinished = false` is the CORE-17 in-progress domain-state case: the row
 * exists (durable across an app kill, crash-recovery) but has never been
 * enqueued for sync — the "local"/"Saved on device" pill state. Finish flips
 * it to `true` and `syncStatus` to `pending`, which is what actually queues
 * the push (mirrors `recording_sessions` -> `activities` for Module A, but
 * folded into one table since sets are built up incrementally through the
 * session rather than auto-collected).
 */
export type LocalWorkoutSession = {
  id: string;
  userId: string;
  title: string | null;
  notes: string | null;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  durationSeconds: number;
  sourceTemplateId: string | null;
  templateNameSnapshot: string | null;
  sessionRpe: number | null;
  totalVolumeKg: number | null;
  totalSets: number | null;
  caloriesSource: CaloriesSource;
  energyKcal: number | null;
  source: WorkoutSource;
  visibility: WorkoutVisibility;
  loadScore: number | null;
  clientCreatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  isFinished: boolean;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type LocalWorkoutTemplate = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Has this row's id ever been confirmed by a successful server INSERT (first-create vs. edit for the push side). */
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type LocalWorkoutTemplateExercise = {
  id: string;
  templateId: string;
  userId: string;
  exerciseId: string | null;
  customExerciseId: string | null;
  exerciseNameSnapshot: string; // display-only local convenience, not sent to the server (templates have no snapshot server-side, §1.7)
  exerciseOrder: number;
  targetSets: number | null;
  targetRepsLow: number | null;
  targetRepsHigh: number | null;
  targetWeightKg: number | null;
  targetRestSeconds: number | null;
  notes: string | null;
  deletedLocally: boolean; // real DELETE server-side (§8), so local removal just needs a "pending delete" marker until pushed
  /** Has this exact child row's id ever been confirmed by a successful server INSERT. */
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type LocalProgram = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  lengthWeeks: number | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Has this row's id ever been confirmed by a successful server INSERT (first-create vs. edit for the push side). */
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type LocalProgramWorkout = {
  id: string;
  programId: string;
  userId: string;
  templateId: string;
  templateNameLocal: string; // display convenience
  weekNumber: number | null;
  dayNumber: number | null;
  sortOrder: number;
  deletedLocally: boolean;
  /** Has this exact child row's id ever been confirmed by a successful server INSERT. */
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type StrengthPrMetric = 'heaviest_weight' | 'estimated_1rm' | 'best_set_volume' | 'max_reps';

export type LocalStrengthRecord = {
  userId: string;
  exerciseId: string | null;
  customExerciseId: string | null;
  metric: StrengthPrMetric;
  value: number;
  unitSnapshot: string | null;
  sourceSetLogId: string;
  timelineEventId: string;
  achievedAt: string;
  previousValue: number | null;
  confirmed: boolean;
};

export type LocalStrengthAchievement = {
  id: string;
  timelineEventId: string;
  sourceSetLogId: string;
  userId: string;
  metric: StrengthPrMetric;
  value: number;
  isOptimistic: boolean;
};

/** 1:1 with a `bodyweight` timeline event (architecture §1.9), health-consent-gated. */
export type LocalBodyweightLog = {
  id: string; // = timeline_event_id
  userId: string;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  weightKg: number;
  unitWeightSnapshot: UnitWeightSnapshot;
  bodyFatPct: number | null;
  source: 'manual' | 'wearable';
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type MeasurementKind =
  | 'waist' | 'chest' | 'hips' | 'thigh' | 'biceps' | 'calf' | 'neck' | 'shoulders' | 'forearm' | 'body_fat_pct';
export type MeasurementUnitSnapshot = 'cm' | 'in' | 'pct';

export type LocalBodyMeasurementValue = {
  measurementKind: MeasurementKind;
  value: number;
  unitSnapshot: MeasurementUnitSnapshot;
};

/** 1:1 with a `body_measurement` timeline event + its child site values, health-consent-gated. */
export type LocalBodyMeasurement = {
  id: string; // = timeline_event_id
  userId: string;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  notes: string | null;
  values: LocalBodyMeasurementValue[];
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type PhotoPose = 'front' | 'side' | 'back' | 'other';
export type PhotoUploadStatus = 'pending' | 'uploaded' | 'failed';

export type LocalProgressPhotoImage = {
  id: string;
  timelineEventId: string;
  pose: PhotoPose;
  localUri: string | null; // on-device file, retained until uploaded (§10 upload-then-metadata)
  objectPath: string | null; // set once uploaded to the progress-photos bucket
  checksum: string | null;
  uploadStatus: PhotoUploadStatus;
};

/** 1:1 with a `progress_photo` timeline event (one occasion) + its per-pose images, body_image-consent-gated. */
export type LocalProgressPhoto = {
  id: string; // = timeline_event_id
  userId: string;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  notes: string | null;
  images: LocalProgressPhotoImage[];
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

// ---------------------------------------------------------------------------
// Phase 3 — Module B (nutrition & food logging). Design ref:
// docs/architecture/phase-3-module-b.md, docs/api/save-food-log-entry-v1.md,
// docs/api/save-water-and-manual-burn-v1.md,
// docs/api/daily-energy-balance-and-macros-v1.md,
// docs/api/search-foods-and-resolve-barcode-v1.md, docs/design/screens-phase-3.md.
// ---------------------------------------------------------------------------

export type FoodSource = 'usda_fdc' | 'open_food_facts' | 'milelift_authored';
export type FoodMeasureBasis = 'per_100g' | 'per_100ml';
export type FoodDataQuality = 'high' | 'medium' | 'low';

export type FoodServing = {
  id: string;
  label: string;
  gramOrMlWeight: number;
  isDefault: boolean;
};

/**
 * Bounded local CACHE of a resolved catalog food (§2.4/§9 — "cache what the
 * user has searched/logged/scanned," never a full-catalog mirror). Populated
 * from `search_foods_v1`/`resolve_barcode_v1` responses and read back for
 * offline search-of-recents, offline barcode resolution, and the CORE-10
 * offline saved-meal cached-macro fallback. Read-only from the server's point
 * of view — never pushed.
 */
export type LocalFoodCacheEntry = {
  foodId: string;
  source: FoodSource;
  name: string;
  brand: string | null;
  barcode: string | null;
  basis: FoodMeasureBasis;
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  dataQuality: FoodDataQuality;
  attribution: string | null;
  servings: FoodServing[];
  cachedAt: string;
  lastUsedAt: string;
};

/** Owner-owned, offline-first (CORE-06/07 barcode-miss landing spot, §1.4). */
export type LocalCustomFood = {
  id: string;
  userId: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  basis: FoodMeasureBasis;
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  defaultServingGOrMl: number | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
export type NutritionSource = 'manual' | 'import';
export type NutritionVisibility = 'private' | 'followers' | 'public';

/**
 * One row of the local `food_log_entries` mirror — spine (timeline_events)
 * fields + meal fields merged, the `activities`/`workout_sessions`
 * simplification (schema.ts header). `committedAt = null` is the CORE-06
 * "draft meal tray" domain-state case (architecture §9: "a meal being
 * assembled is layer-2 local domain state, durable in SQLite") — the row and
 * its items exist locally (crash-durable) as items are added, but are never
 * included in `getUnsynced()` until "Save meal"/"Log food" sets
 * `committedAt`, mirroring `workout_sessions.isFinished`.
 */
export type LocalFoodLogEntry = {
  id: string; // = timeline_event_id
  userId: string;
  mealType: MealType;
  title: string | null;
  notes: string | null;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  totalEnergyKcal: number;
  totalProteinG: number | null;
  totalCarbG: number | null;
  totalFatG: number | null;
  source: NutritionSource;
  visibility: NutritionVisibility;
  clientCreatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  committedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

/** One row of the local `food_log_items` mirror — the CORE-06 firehose (architecture §1.6, §9). */
export type LocalFoodLogItem = {
  id: string;
  timelineEventId: string;
  userId: string;
  foodId: string | null;
  customFoodId: string | null;
  foodNameSnapshot: string;
  brandSnapshot: string | null;
  servingLabelSnapshot: string;
  quantity: number;
  servingGOrMlSnapshot: number;
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  dataQualitySnapshot: FoodDataQuality | null;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Has this row changed locally since it was last confirmed synced (mirrors `LocalWorkoutSet.dirty`). */
  dirty: boolean;
  serverConfirmed: boolean;
};

export type UnitVolumeSnapshot = 'ml' | 'fl_oz';
export type WaterSource = 'manual' | 'wearable' | 'import';

/** 1:1 with a `water_intake` timeline event (CORE-09, §1.7). Not consent-gated. */
export type LocalWaterIntakeLog = {
  id: string; // = timeline_event_id
  userId: string;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  volumeMl: number;
  unitVolumeSnapshot: UnitVolumeSnapshot;
  source: WaterSource;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type ManualBurnEnergySource = 'user_entered' | 'estimated';

export type OverlapAdvisoryEvent = {
  timelineEventId: string;
  eventType: string;
  occurredAt: string;
  durationSeconds: number | null;
  energyKcal: number | null;
};

export type OverlapAdvisory = {
  hasOverlap: boolean;
  overlappingEvents: OverlapAdvisoryEvent[];
};

/** 1:1 with a `manual_calorie_burn` timeline event (CORE-11, §1.8). `energyKcal` is stored as the POSITIVE magnitude the user entered locally; sync writes it negative onto the spine per `save_manual_burn_v1`'s contract. */
export type LocalManualBurnLog = {
  id: string; // = timeline_event_id
  userId: string;
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  energyKcalMagnitude: number;
  label: string;
  activityTypeCode: string | null;
  durationMinutes: number | null;
  energySource: ManualBurnEnergySource;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  /** The CORE-11 soft, non-blocking overlap advisory (§4.3) — optimistically computed on-device pre-sync, reconciled with the RPC's response on sync. Never blocks save. */
  overlapAdvisory: OverlapAdvisory | null;
  overlapAdvisoryDismissed: boolean;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

/** Owner-owned *definition*, not an event (CORE-10, §1.10) — the `workout_templates` precedent. */
export type LocalSavedMeal = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  mealType: MealType | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

/** Child of `saved_meals` (§1.10) — NO macro snapshot (a saved meal is a live plan; macros resolve at log time). `foodNameSnapshotLocal` is a local-only display convenience, never sent to the server (mirrors `LocalWorkoutTemplateExercise.exerciseNameSnapshot`). */
export type LocalSavedMealItem = {
  id: string;
  savedMealId: string;
  userId: string;
  foodId: string | null;
  customFoodId: string | null;
  foodNameSnapshotLocal: string;
  servingLabel: string;
  servingGOrMl: number;
  quantity: number;
  sortOrder: number;
  deletedLocally: boolean;
  serverConfirmed: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};
