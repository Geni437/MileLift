import {
  HC_EXERCISE_TYPE,
  activityTypeToHealthConnectExerciseType,
  healthConnectExerciseTypeToActivityType,
} from '../features/health-connect/exerciseTypeMap';

describe('activityTypeToHealthConnectExerciseType', () => {
  it('maps known codes to their Health Connect exercise type', () => {
    expect(activityTypeToHealthConnectExerciseType('run')).toBe(HC_EXERCISE_TYPE.RUNNING);
    expect(activityTypeToHealthConnectExerciseType('ride')).toBe(HC_EXERCISE_TYPE.BIKING);
    expect(activityTypeToHealthConnectExerciseType('hike')).toBe(HC_EXERCISE_TYPE.HIKING);
  });

  it('falls back to OTHER_WORKOUT for an unrecognized code rather than throwing', () => {
    expect(activityTypeToHealthConnectExerciseType('made_up_type')).toBe(HC_EXERCISE_TYPE.OTHER_WORKOUT);
  });
});

describe('healthConnectExerciseTypeToActivityType', () => {
  it('maps a known exercise type back to our catalog code', () => {
    expect(healthConnectExerciseTypeToActivityType(HC_EXERCISE_TYPE.RUNNING)).toBe('run');
    expect(healthConnectExerciseTypeToActivityType(HC_EXERCISE_TYPE.WALKING)).toBe('walk');
  });

  it('falls back to "other" for an exercise type with no MileLift equivalent', () => {
    expect(healthConnectExerciseTypeToActivityType(999)).toBe('other');
  });
});
