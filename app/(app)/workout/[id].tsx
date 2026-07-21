import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { TextButton } from '../../../src/components/TextButton';
import { ConfirmSheet } from '../../../src/components/ConfirmSheet';
import { MetricBar } from '../../../src/components/activity/MetricBar';
import { MuscleTag } from '../../../src/components/strength/MuscleTag';
import { PrBadge } from '../../../src/components/activity/PrBadge';
import { LiftStack, type LiftStackSegment } from '../../../src/components/strength/LiftStack';
import { SetTypeTag } from '../../../src/components/strength/SetTypeTag';
import { workoutSessionsRepository } from '../../../src/db/repositories/workoutSessionsRepository';
import { strengthAchievementsRepository } from '../../../src/db/repositories/strengthAchievementsRepository';
import { formatDuration, formatRelativeDateTime, formatReps, formatVolumeValue, formatWeightValue } from '../../../src/lib/format';
import { useProfile } from '../../../src/state/ProfileContext';
import { runSync } from '../../../src/sync/syncEngine';
import type { LocalWorkoutSession, LocalWorkoutSet } from '../../../src/db/types';

/** CORE-15 session detail: LiftStack hero, summary, per-exercise breakdown, edit/delete. */
export default function WorkoutDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfile();
  const unitWeight = profile?.unitWeight ?? 'kg';

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<LocalWorkoutSession | null>(null);
  const [sets, setSets] = useState<LocalWorkoutSet[]>([]);
  const [hasPr, setHasPr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [s, setRows, achievements] = await Promise.all([
        workoutSessionsRepository.getSession(id),
        workoutSessionsRepository.getSetsForSession(id),
        strengthAchievementsRepository.getForSession(id),
      ]);
      setSession(s);
      setSets(setRows);
      setHasPr(achievements.length > 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this session.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // Synchronizes local list/detail state with the local SQLite store on
    // mount / id change — same legitimate pattern as ProfileContext's own effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <SkeletonBlock height={160} radius={theme.radius.lg} />
          <SkeletonBlock height={24} width={200} />
          <SkeletonBlock height={80} radius={theme.radius.md} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !session) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <InlineBanner
            tone="warning"
            message={error ? `Couldn't load this session — ${error} Anything saved on this device is still here.` : 'This session could not be found.'}
            actionLabel="Retry"
            onAction={() => void load()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const byExercise = new Map<number, LocalWorkoutSet[]>();
  for (const s of sets) {
    const list = byExercise.get(s.exerciseOrder) ?? [];
    list.push(s);
    byExercise.set(s.exerciseOrder, list);
  }
  const exerciseGroups = Array.from(byExercise.entries()).sort(([a], [b]) => a - b);

  const segments: LiftStackSegment[] = sets
    .filter((s) => s.isCompleted && s.setType === 'working')
    .map((s) => ({ key: s.id, volume: (s.reps ?? 0) * (s.weightKg ?? (s.isBodyweight ? 1 : 0)), isPr: false }));

  const muscles = Array.from(new Set(sets.map((s) => s.primaryMuscleSnapshot).filter((m): m is NonNullable<typeof m> => !!m)));

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TextButton label="Back" onPress={() => router.back()} />
        </View>

        <LiftStack variant="static" segments={segments} height={180} />

        <View style={styles.titleRow}>
          <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            {session.title ?? 'Workout'}
          </Text>
          {hasPr && <PrBadge />}
        </View>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {formatRelativeDateTime(session.occurredAt)}
          {session.templateNameSnapshot ? ` · ${session.templateNameSnapshot}` : ''}
        </Text>

        <MetricBar
          items={[
            { key: 'volume', value: formatVolumeValue(session.totalVolumeKg, unitWeight), unit: unitWeight, label: 'Volume' },
            { key: 'sets', value: String(session.totalSets ?? 0), label: 'Sets' },
            { key: 'duration', value: formatDuration(session.durationSeconds), label: 'Duration' },
            ...(session.loadScore != null ? [{ key: 'load', value: String(Math.round(session.loadScore)), label: 'Load' }] : []),
          ]}
        />

        {exerciseGroups.map(([order, exerciseSets]) => {
          const first = exerciseSets[0]!;
          const bestSet = exerciseSets
            .filter((s) => s.isCompleted && s.setType === 'working')
            .sort((a, b) => (b.estimated1rmKg ?? 0) - (a.estimated1rmKg ?? 0))[0];
          return (
            <View key={order} style={styles.exerciseSection}>
              <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                {first.exerciseNameSnapshot}
              </Text>
              {exerciseSets
                .sort((a, b) => a.setNumber - b.setNumber)
                .map((s) => (
                  <View
                    key={s.id}
                    style={[styles.setRow, s.id === bestSet?.id && { backgroundColor: theme.color.accent.dataTint }, s.setType === 'warmup' && { opacity: 0.6 }]}
                  >
                    <SetTypeTag setType={s.setType} setNumber={s.setNumber} />
                    <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                      {formatWeightValue(s.weightKg, s.unitWeightSnapshot)} × {formatReps(s.reps)}
                    </Text>
                    {s.estimated1rmKg != null && (
                      <Text style={[theme.type.caption, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.8}>
                        e1RM {formatWeightValue(s.estimated1rmKg, s.unitWeightSnapshot)}
                      </Text>
                    )}
                  </View>
                ))}
            </View>
          );
        })}

        {muscles.length > 0 && (
          <View style={styles.muscleSection}>
            <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              Muscles worked
            </Text>
            <View style={styles.muscleRow}>
              {muscles.map((m) => (
                <MuscleTag key={m} muscle={m} />
              ))}
            </View>
          </View>
        )}

        <View style={styles.actionsRow}>
          <TextButton label="Edit" onPress={() => router.push({ pathname: '/workout', params: { editSessionId: session.id } })} />
          <TextButton label="Delete" danger onPress={() => setShowDeleteConfirm(true)} />
        </View>
      </ScrollView>

      <ConfirmSheet
        visible={showDeleteConfirm}
        title="Delete this workout?"
        body="This session moves to trash for 30 days, then is permanently deleted."
        confirmLabel="Delete"
        onConfirm={async () => {
          await workoutSessionsRepository.softDelete(session.id);
          setShowDeleteConfirm(false);
          void runSync('post-write');
          router.back();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.md },
  headerRow: { flexDirection: 'row' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  exerciseSection: { gap: theme.space.xxs, marginTop: theme.space.sm },
  setRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, minHeight: theme.touchTarget.min, paddingHorizontal: theme.space.xs, borderRadius: theme.radius.sm },
  muscleSection: { gap: theme.space.xs, marginTop: theme.space.md },
  muscleRow: { flexDirection: 'row', gap: theme.space.xs, flexWrap: 'wrap' },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: theme.space.lg },
});
