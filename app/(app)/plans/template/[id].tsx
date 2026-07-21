import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../../src/theme';
import { Field } from '../../../../src/components/Field';
import { PrimaryButton } from '../../../../src/components/PrimaryButton';
import { TextButton } from '../../../../src/components/TextButton';
import { ConfirmSheet } from '../../../../src/components/ConfirmSheet';
import { workoutTemplatesRepository, type TemplateExerciseFields } from '../../../../src/db/repositories/workoutTemplatesRepository';
import { programsRepository } from '../../../../src/db/repositories/programsRepository';
import { generateUuidV4 } from '../../../../src/lib/uuid';
import { openExercisePicker } from '../../../../src/lib/exercisePickerBridge';
import { runSync } from '../../../../src/sync/syncEngine';
import { useAuth } from '../../../../src/state/AuthContext';
import type { LocalWorkoutTemplateExercise } from '../../../../src/db/types';

/** CORE-14 template builder — a live plan, no snapshot here (the snapshot happens when a session is logged FROM it, §3). */
export default function TemplateBuilderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [exercises, setExercises] = useState<LocalWorkoutTemplateExercise[]>([]);
  const [usedInProgram, setUsedInProgram] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const template = await workoutTemplatesRepository.getById(id);
    if (template) {
      setName(template.name);
      setDescription(template.description ?? '');
    }
    const ex = await workoutTemplatesRepository.listExercises(id);
    setExercises(ex.sort((a, b) => a.exerciseOrder - b.exerciseOrder));
    if (userId) {
      const inUse = await programsRepository.templateIdsInUse(userId);
      setUsedInProgram(inUse.has(id));
    }
    setLoading(false);
  }, [id, userId]);

  useEffect(() => {
    // Synchronizes local list/detail state with the local SQLite store on
    // mount / id change — same legitimate pattern as ProfileContext's own effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSaveMeta = async () => {
    if (!id) return;
    await workoutTemplatesRepository.update(id, name.trim() || 'Template', description.trim() || null);
    void runSync('post-write');
  };

  const handleAddExercise = () => {
    openExercisePicker((result) => {
      void (async () => {
        if (!id || !userId) return;
        const order = exercises.length === 0 ? 0 : Math.max(...exercises.map((e) => e.exerciseOrder)) + 1;
        const fields: TemplateExerciseFields = {
          exerciseId: result.exerciseId,
          customExerciseId: result.customExerciseId,
          exerciseNameSnapshot: result.name,
          exerciseOrder: order,
          targetSets: 3,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetWeightKg: null,
          targetRestSeconds: 90,
          notes: null,
        };
        await workoutTemplatesRepository.upsertExercise(generateUuidV4(), id, userId, fields);
        void runSync('post-write');
        await load();
      })();
    });
  };

  const handleRemoveExercise = async (exerciseId: string) => {
    await workoutTemplatesRepository.removeExercise(exerciseId);
    void runSync('post-write');
    await load();
  };

  const handleMove = async (exercise: LocalWorkoutTemplateExercise, direction: 'up' | 'down') => {
    const sorted = [...exercises].sort((a, b) => a.exerciseOrder - b.exerciseOrder);
    const index = sorted.findIndex((e) => e.id === exercise.id);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= sorted.length) return;
    const other = sorted[targetIndex]!;
    await workoutTemplatesRepository.upsertExercise(exercise.id, exercise.templateId, exercise.userId, { ...toFields(exercise), exerciseOrder: other.exerciseOrder });
    await workoutTemplatesRepository.upsertExercise(other.id, other.templateId, other.userId, { ...toFields(other), exerciseOrder: exercise.exerciseOrder });
    void runSync('post-write');
    await load();
  };

  const handleDelete = async () => {
    if (!id) return;
    await workoutTemplatesRepository.softDelete(id);
    void runSync('post-write');
    setShowDeleteConfirm(false);
    router.back();
  };

  if (loading) return <SafeAreaView style={styles.safe} />;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TextButton label="Back" onPress={() => router.back()} />
          <TextButton label="Delete" danger onPress={() => setShowDeleteConfirm(true)} />
        </View>

        <Field label="Name" value={name} onChangeText={setName} onBlur={() => void handleSaveMeta()} />
        <Field label="Description (optional)" value={description} onChangeText={setDescription} onBlur={() => void handleSaveMeta()} />

        <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
          Exercises
        </Text>
        {exercises.map((ex, index) => (
          <View key={ex.id} style={[styles.exerciseRow, { borderColor: theme.color.border.subtle }]}>
            <View style={styles.exerciseHeader}>
              <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                {ex.exerciseNameSnapshot}
              </Text>
              <View style={styles.exerciseActions}>
                <TextButton label="Up" disabled={index === 0} onPress={() => void handleMove(ex, 'up')} />
                <TextButton label="Down" disabled={index === exercises.length - 1} onPress={() => void handleMove(ex, 'down')} />
                <TextButton label="Remove" danger onPress={() => void handleRemoveExercise(ex.id)} />
              </View>
            </View>
            {/* Metric-face dual readout (design doc §B) — not one plain caption
                string; mirrors the SaveSheet SummaryStat pattern. */}
            <View style={styles.targetRow}>
              <TargetStat value={ex.targetSets != null ? String(ex.targetSets) : '–'} label="Sets" />
              <TargetStat value={`${ex.targetRepsLow ?? '–'}–${ex.targetRepsHigh ?? '–'}`} label="Reps" />
              <TargetStat value={ex.targetRestSeconds != null ? `${ex.targetRestSeconds}s` : '–'} label="Rest" />
            </View>
          </View>
        ))}
        <TextButton label="＋ Add exercise" onPress={handleAddExercise} />

        <PrimaryButton
          label="Start workout from this template"
          onPress={() => id && router.push({ pathname: '/workout', params: { templateId: id } })}
          disabled={exercises.length === 0}
        />
      </ScrollView>

      <ConfirmSheet
        visible={showDeleteConfirm}
        title="Delete this template?"
        body={
          usedInProgram
            ? `${name || 'This template'} is used in one of your programs. Delete it there too — workouts you've already logged from it stay in your history.`
            : "Workouts you've already logged from it stay in your history."
        }
        confirmLabel="Delete"
        onConfirm={() => void handleDelete()}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </SafeAreaView>
  );
}

function TargetStat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.targetStat}>
      <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
        {value}
      </Text>
      <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

function toFields(ex: LocalWorkoutTemplateExercise): TemplateExerciseFields {
  return {
    exerciseId: ex.exerciseId,
    customExerciseId: ex.customExerciseId,
    exerciseNameSnapshot: ex.exerciseNameSnapshot,
    exerciseOrder: ex.exerciseOrder,
    targetSets: ex.targetSets,
    targetRepsLow: ex.targetRepsLow,
    targetRepsHigh: ex.targetRepsHigh,
    targetWeightKg: ex.targetWeightKg,
    targetRestSeconds: ex.targetRestSeconds,
    notes: ex.notes,
  };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.md },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  exerciseRow: { borderWidth: theme.border.hairline, borderRadius: theme.radius.md, padding: theme.space.sm, gap: theme.space.xxs },
  exerciseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  exerciseActions: { flexDirection: 'row' },
  targetRow: { flexDirection: 'row', gap: theme.space.md },
  targetStat: { gap: 2 },
});
