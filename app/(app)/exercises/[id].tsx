import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { TextButton } from '../../../src/components/TextButton';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { MuscleTag, EquipmentTag } from '../../../src/components/strength/MuscleTag';
import { MeridianMark } from '../../../src/components/MeridianMark';
import { exercisesRepository } from '../../../src/db/repositories/exercisesRepository';
import type { LocalExercise, LocalExerciseMedia } from '../../../src/db/types';

/** CORE-13 exercise detail: metadata, instructions, in-app attribution (the §6/§12.1 gate item), "Video coming soon" — never a player state (§2/§13). */
export default function ExerciseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [exercise, setExercise] = useState<LocalExercise | null>(null);
  const [media, setMedia] = useState<LocalExerciseMedia[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    void Promise.all([exercisesRepository.getById(id), exercisesRepository.getMediaFor(id)]).then(([ex, m]) => {
      setExercise(ex);
      setMedia(m);
      setLoading(false);
    });
  }, [id]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <SkeletonBlock height={220} radius={theme.radius.lg} />
          <SkeletonBlock height={24} width={200} />
          <SkeletonBlock height={80} radius={theme.radius.md} />
        </View>
      </SafeAreaView>
    );
  }

  if (!exercise) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            This exercise couldn&apos;t be found — it may be offline-cached only on another device.
          </Text>
          <TextButton label="Back" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const hasVideo = media.some((m) => m.mediaType === 'video');

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.imagePlaceholder, { backgroundColor: theme.color.bg.inset }]}>
          <MeridianMark variant="glyph" size={56} />
          {!hasVideo && (
            <Text style={[theme.type.overline, styles.videoTag, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.8}>
              VIDEO COMING SOON
            </Text>
          )}
        </View>

        <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          {exercise.name}
        </Text>
        <View style={styles.tagsRow}>
          <MuscleTag muscle={exercise.primaryMuscle} />
          <EquipmentTag equipment={exercise.equipment} />
        </View>

        {exercise.instructions && (
          <Text style={[theme.type.body, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
            {exercise.instructions}
          </Text>
        )}

        {exercise.attribution && (
          <Text style={[theme.type.caption, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={2}>
            {exercise.attribution}
          </Text>
        )}
        <TextButton label="Exercise data credits" onPress={() => router.push('/exercise-credits')} />

        {/* "Log this" starts a fresh workout with this movement pre-added
            (design doc CORE-13). The picker-mode "Add to workout" action
            applies only when this screen is reached FROM the picker flow —
            not built in this pass, since `exercises.tsx`'s pick mode
            resolves directly from the list row without drilling into detail
            (a documented, reasonable simplification for a first pass). */}
        <PrimaryButton label="Log this" onPress={() => router.push({ pathname: '/workout', params: { prefillExerciseId: exercise.id } })} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.md },
  imagePlaceholder: { height: 220, borderRadius: theme.radius.lg, alignItems: 'center', justifyContent: 'center', gap: theme.space.sm },
  videoTag: {},
  tagsRow: { flexDirection: 'row', gap: theme.space.xs },
});
