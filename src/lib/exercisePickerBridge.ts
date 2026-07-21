import { router } from 'expo-router';

import type { ExerciseFieldFlags, MuscleGroup } from '../db/types';

export type ExercisePickerResult = {
  exerciseId: string | null;
  customExerciseId: string | null;
  name: string;
  primaryMuscle: MuscleGroup | null;
  fieldFlags: ExerciseFieldFlags;
};

/**
 * A minimal, single-purpose transient bridge for the one navigation
 * hand-off expo-router doesn't natively support: "push a picker screen,
 * come back with a value." NOT a general state-management layer (the app's
 * actual state layers — server cache / local domain / UI — stay exactly as
 * documented in ConsentContext/ProfileContext/AuthContext; this holds
 * nothing but an in-flight callback reference for the duration of one modal
 * navigation and is cleared the instant it's consumed).
 */
let pendingResolver: ((result: ExercisePickerResult) => void) | null = null;

export function openExercisePicker(onSelect: (result: ExercisePickerResult) => void): void {
  pendingResolver = onSelect;
  router.push({ pathname: '/exercises', params: { mode: 'pick' } });
}

export function resolveExercisePicker(result: ExercisePickerResult): void {
  const resolver = pendingResolver;
  pendingResolver = null;
  resolver?.(result);
}

export function cancelExercisePicker(): void {
  pendingResolver = null;
}
