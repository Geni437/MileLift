/**
 * MileLift `activity_types.code` <-> Health Connect `ExerciseType` numeric
 * constant mapping (architecture §3.1/§3.2). Pure and testable — no native
 * import here, just the lookup tables the client/hook uses on both the
 * inbound (read) and outbound (write-back) paths.
 *
 * Health Connect's `ExerciseType` constants come from `react-native-health-
 * connect`'s `constants.ts` (Android's own `ExerciseSessionRecord` type
 * enum) — see that package for the authoritative numeric values.
 */

// Numeric values copied from react-native-health-connect's ExerciseType
// constant (not imported directly so this module has zero native-module
// dependency and stays trivially unit-testable).
export const HC_EXERCISE_TYPE = {
  OTHER_WORKOUT: 0,
  BIKING: 8,
  BIKING_STATIONARY: 9,
  ELLIPTICAL: 25,
  HIGH_INTENSITY_INTERVAL_TRAINING: 36,
  HIKING: 37,
  ROWING: 53,
  ROWING_MACHINE: 54,
  RUNNING: 56,
  SKIING: 61,
  SNOWBOARDING: 62,
  STAIR_CLIMBING_MACHINE: 69,
  SWIMMING_OPEN_WATER: 73,
  SWIMMING_POOL: 74,
  WALKING: 79,
  YOGA: 83,
} as const;

/** Outbound (MileLift -> Health Connect): our activity type code decides the exercise type we write back. */
export const ACTIVITY_TYPE_TO_HC_EXERCISE_TYPE: Record<string, number> = {
  run: HC_EXERCISE_TYPE.RUNNING,
  trail_run: HC_EXERCISE_TYPE.RUNNING,
  walk: HC_EXERCISE_TYPE.WALKING,
  hike: HC_EXERCISE_TYPE.HIKING,
  ride: HC_EXERCISE_TYPE.BIKING,
  mountain_bike_ride: HC_EXERCISE_TYPE.BIKING,
  indoor_ride: HC_EXERCISE_TYPE.BIKING_STATIONARY,
  swim_open_water: HC_EXERCISE_TYPE.SWIMMING_OPEN_WATER,
  swim_pool: HC_EXERCISE_TYPE.SWIMMING_POOL,
  row: HC_EXERCISE_TYPE.ROWING,
  indoor_row: HC_EXERCISE_TYPE.ROWING_MACHINE,
  ski_alpine: HC_EXERCISE_TYPE.SKIING,
  ski_nordic: HC_EXERCISE_TYPE.SKIING,
  snowboard: HC_EXERCISE_TYPE.SNOWBOARDING,
  elliptical: HC_EXERCISE_TYPE.ELLIPTICAL,
  stair_stepper: HC_EXERCISE_TYPE.STAIR_CLIMBING_MACHINE,
  hiit: HC_EXERCISE_TYPE.HIGH_INTENSITY_INTERVAL_TRAINING,
  yoga: HC_EXERCISE_TYPE.YOGA,
  other: HC_EXERCISE_TYPE.OTHER_WORKOUT,
};

/** Inbound (Health Connect -> MileLift): reverse lookup, falling back to `other` for any exercise type this catalog doesn't have a dedicated code for (architecture §3.1: "activity_type_code mapped from the Health Connect exercise type"). */
const HC_EXERCISE_TYPE_TO_ACTIVITY_TYPE: Record<number, string> = {
  [HC_EXERCISE_TYPE.RUNNING]: 'run',
  [HC_EXERCISE_TYPE.WALKING]: 'walk',
  [HC_EXERCISE_TYPE.HIKING]: 'hike',
  [HC_EXERCISE_TYPE.BIKING]: 'ride',
  [HC_EXERCISE_TYPE.BIKING_STATIONARY]: 'indoor_ride',
  [HC_EXERCISE_TYPE.SWIMMING_OPEN_WATER]: 'swim_open_water',
  [HC_EXERCISE_TYPE.SWIMMING_POOL]: 'swim_pool',
  [HC_EXERCISE_TYPE.ROWING]: 'row',
  [HC_EXERCISE_TYPE.ROWING_MACHINE]: 'indoor_row',
  [HC_EXERCISE_TYPE.SKIING]: 'ski_alpine',
  [HC_EXERCISE_TYPE.SNOWBOARDING]: 'snowboard',
  [HC_EXERCISE_TYPE.ELLIPTICAL]: 'elliptical',
  [HC_EXERCISE_TYPE.STAIR_CLIMBING_MACHINE]: 'stair_stepper',
  [HC_EXERCISE_TYPE.HIGH_INTENSITY_INTERVAL_TRAINING]: 'hiit',
  [HC_EXERCISE_TYPE.YOGA]: 'yoga',
};

export function activityTypeToHealthConnectExerciseType(activityTypeCode: string): number {
  return ACTIVITY_TYPE_TO_HC_EXERCISE_TYPE[activityTypeCode] ?? HC_EXERCISE_TYPE.OTHER_WORKOUT;
}

export function healthConnectExerciseTypeToActivityType(exerciseType: number): string {
  return HC_EXERCISE_TYPE_TO_ACTIVITY_TYPE[exerciseType] ?? 'other';
}
