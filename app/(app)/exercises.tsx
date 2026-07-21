import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { Field } from '../../src/components/Field';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { TextButton } from '../../src/components/TextButton';
import { SkeletonBlock } from '../../src/components/SkeletonBlock';
import { EmptyState } from '../../src/components/EmptyState';
import { SyncStatusPill } from '../../src/components/SyncStatusPill';
import { ExerciseRow } from '../../src/components/strength/ExerciseRow';
import { exercisesRepository, exerciseFieldFlags } from '../../src/db/repositories/exercisesRepository';
import { customExercisesRepository } from '../../src/db/repositories/customExercisesRepository';
import { generateUuidV4 } from '../../src/lib/uuid';
import { runSync } from '../../src/sync/syncEngine';
import { useAuth } from '../../src/state/AuthContext';
import { resolveExercisePicker, cancelExercisePicker } from '../../src/lib/exercisePickerBridge';
import { resolveExerciseMediaUrl } from '../../src/lib/exerciseMedia';
import type { LocalCustomExercise, LocalExercise, MuscleGroup } from '../../src/db/types';

/** Batch-resolves + merges primary media URLs for a page of exercises into the running map — one query per visible page/search result set, never per-row (N+1). */
async function loadImageUrls(exerciseIds: string[], setImageUrlByExerciseId: React.Dispatch<React.SetStateAction<Map<string, string>>>) {
  if (exerciseIds.length === 0) return;
  const mediaByExerciseId = await exercisesRepository.getPrimaryMediaFor(exerciseIds);
  if (mediaByExerciseId.size === 0) return;
  setImageUrlByExerciseId((prev) => {
    const next = new Map(prev);
    for (const [exerciseId, media] of mediaByExerciseId) next.set(exerciseId, resolveExerciseMediaUrl(media.urlOrObjectPath));
    return next;
  });
}

const MUSCLE_FILTERS: MuscleGroup[] = ['chest', 'back', 'quadriceps', 'shoulders', 'biceps', 'triceps', 'glutes', 'abs'];

type TrackKind = 'weighted' | 'bodyweight' | 'time' | 'distance';

/** CORE-13 — exercise library browse/search/filter + custom-exercise creation. `?mode=pick` returns a selection to the caller via `exercisePickerBridge`. */
export default function ExercisesScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isPickMode = mode === 'pick';
  const { userId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [muscleFilter, setMuscleFilter] = useState<MuscleGroup | null>(null);
  const [showMyExercises, setShowMyExercises] = useState(false);
  const [grouped, setGrouped] = useState<Map<MuscleGroup, LocalExercise[]>>(new Map());
  const [searchResults, setSearchResults] = useState<LocalExercise[] | null>(null);
  const [customExercises, setCustomExercises] = useState<LocalCustomExercise[]>([]);
  const [imageUrlByExerciseId, setImageUrlByExerciseId] = useState<Map<string, string>>(new Map());
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [prefillName, setPrefillName] = useState('');

  useEffect(() => {
    void load();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    const [groupedData, customData] = await Promise.all([
      exercisesRepository.listGroupedByMuscle(),
      userId ? customExercisesRepository.listForUser(userId) : Promise.resolve([]),
    ]);
    setGrouped(groupedData);
    setCustomExercises(customData);
    setLoading(false);
    void loadImageUrls(Array.from(groupedData.values()).flat().map((ex) => ex.id), setImageUrlByExerciseId);
  }

  useEffect(() => {
    // Synchronizes the search-result list with the query/filter inputs —
    // legitimate "derive from external SQLite store on input change," same
    // pattern as elsewhere in this codebase.
    if (!query.trim() && !muscleFilter) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchResults(null);
      return;
    }
    void exercisesRepository.search({ query, muscle: muscleFilter, equipment: null, cursorName: null }).then((page) => {
      setSearchResults(page.items);
      void loadImageUrls(page.items.map((ex) => ex.id), setImageUrlByExerciseId);
    });
  }, [query, muscleFilter]);

  const handlePick = (ex: LocalExercise) => {
    if (!isPickMode) {
      router.push({ pathname: '/exercises/[id]', params: { id: ex.id } });
      return;
    }
    resolveExercisePicker({ exerciseId: ex.id, customExerciseId: null, name: ex.name, primaryMuscle: ex.primaryMuscle, fieldFlags: exerciseFieldFlags(ex) });
    router.back();
  };

  const handlePickCustom = (ex: LocalCustomExercise) => {
    if (!isPickMode) return;
    resolveExercisePicker({
      exerciseId: null,
      customExerciseId: ex.id,
      name: ex.name,
      primaryMuscle: ex.primaryMuscle,
      fieldFlags: { isWeighted: ex.isWeighted, isBodyweight: ex.isBodyweight, isTimeBased: ex.isTimeBased, isDistanceBased: ex.isDistanceBased },
    });
    router.back();
  };

  const handleClose = () => {
    if (isPickMode) cancelExercisePicker();
    router.back();
  };

  const noResults = searchResults != null && searchResults.length === 0 && !showMyExercises;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            {isPickMode ? 'Add exercise' : 'Exercises'}
          </Text>
          <TextButton label="Close" onPress={handleClose} />
        </View>
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Search movements" accessibilityLabel="Search exercises" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <FilterChip label="My exercises" selected={showMyExercises} onPress={() => setShowMyExercises((v) => !v)} />
          {MUSCLE_FILTERS.map((m) => (
            <FilterChip key={m} label={m} selected={muscleFilter === m} onPress={() => setMuscleFilter((prev) => (prev === m ? null : m))} />
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.listContent}>
          <SkeletonBlock height={56} radius={theme.radius.md} />
          <SkeletonBlock height={56} radius={theme.radius.md} />
          <SkeletonBlock height={56} radius={theme.radius.md} />
        </View>
      ) : showMyExercises ? (
        <FlatList
          data={customExercises}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState title="No custom exercises yet." body="Create one below to log a movement that isn't in the library." actionLabel="＋ Create custom exercise" onAction={() => setShowCreateForm(true)} />
          }
          renderItem={({ item }) => (
            <View style={styles.customRow}>
              <ExerciseRow name={item.name} primaryMuscle={item.primaryMuscle} equipment={item.equipment} onPress={() => handlePickCustom(item)} />
              {item.syncStatus !== 'synced' && <SyncStatusPill status={item.syncStatus} />}
            </View>
          )}
          ListHeaderComponent={<TextButton label="＋ Create custom exercise" onPress={() => setShowCreateForm(true)} />}
        />
      ) : noResults ? (
        <View style={styles.listContent}>
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            No match for &quot;{query}&quot;. Create it as a custom exercise?
          </Text>
          <PrimaryButton
            label="＋ Create custom exercise"
            onPress={() => {
              setPrefillName(query);
              setShowCreateForm(true);
            }}
          />
        </View>
      ) : searchResults ? (
        <FlatList
          data={searchResults}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <ExerciseRow
              name={item.name}
              primaryMuscle={item.primaryMuscle}
              equipment={item.equipment}
              imageUrl={imageUrlByExerciseId.get(item.id)}
              onPress={() => handlePick(item)}
            />
          )}
        />
      ) : (
        <GroupedList grouped={grouped} imageUrlByExerciseId={imageUrlByExerciseId} onPick={handlePick} />
      )}

      <CustomExerciseSheet
        visible={showCreateForm}
        userId={userId}
        prefillName={prefillName}
        onClose={() => {
          setShowCreateForm(false);
          setPrefillName('');
        }}
        onCreated={async () => {
          setShowCreateForm(false);
          setPrefillName('');
          await load();
          void runSync('post-write');
        }}
      />
    </SafeAreaView>
  );
}

function GroupedList({
  grouped,
  imageUrlByExerciseId,
  onPick,
}: {
  grouped: Map<MuscleGroup, LocalExercise[]>;
  imageUrlByExerciseId: Map<string, string>;
  onPick: (ex: LocalExercise) => void;
}) {
  const entries = useMemo(() => Array.from(grouped.entries()), [grouped]);
  if (entries.length === 0) {
    return (
      <View style={styles.listContent}>
        <EmptyState title="No exercises available." body="The exercise library couldn't be loaded — you may need to sync once online." />
      </View>
    );
  }
  return (
    <FlatList
      data={entries}
      keyExtractor={([muscle]) => muscle}
      contentContainerStyle={styles.listContent}
      renderItem={({ item: [muscle, exercises] }) => (
        <View style={styles.group}>
          <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
            {muscle.replace('_', ' ')}
          </Text>
          {exercises.map((ex) => (
            <ExerciseRow
              key={ex.id}
              name={ex.name}
              primaryMuscle={ex.primaryMuscle}
              equipment={ex.equipment}
              imageUrl={imageUrlByExerciseId.get(ex.id)}
              onPress={() => onPick(ex)}
            />
          ))}
        </View>
      )}
    />
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.chip, { backgroundColor: selected ? theme.color.accent.primary : theme.color.bg.inset }]}
    >
      <Text style={[theme.type.label, { color: selected ? theme.color.text.onAccent : theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
    </Pressable>
  );
}

function CustomExerciseSheet({
  visible,
  userId,
  prefillName,
  onClose,
  onCreated,
}: {
  visible: boolean;
  userId: string | null;
  prefillName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState(prefillName);
  const [track, setTrack] = useState<TrackKind>('weighted');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Resets the form's name field to the search-empty-state prefill each
    // time the sheet opens — synchronizing local UI state with the prop
    // that triggered it, not a React-Compiler hazard.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setName(prefillName);
  }, [visible, prefillName]);

  const handleSave = async () => {
    if (!userId || !name.trim()) return;
    setSaving(true);
    try {
      await customExercisesRepository.create(generateUuidV4(), userId, {
        name: name.trim(),
        primaryMuscle: null,
        equipment: null,
        isWeighted: track === 'weighted',
        isBodyweight: track === 'bodyweight',
        isTimeBased: track === 'time',
        isDistanceBased: track === 'distance',
        notes: null,
      });
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              New custom exercise
            </Text>
            <Field label="Name" value={name} onChangeText={setName} />
            <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              What does a set track?
            </Text>
            <View style={styles.trackRow}>
              {(
                [
                  ['weighted', 'Weight & reps'],
                  ['bodyweight', 'Reps only'],
                  ['time', 'Time'],
                  ['distance', 'Distance'],
                ] as [TrackKind, string][]
              ).map(([value, label]) => (
                <FilterChip key={value} label={label} selected={track === value} onPress={() => setTrack(value)} />
              ))}
            </View>
            <PrimaryButton label="Save custom exercise" onPress={() => void handleSave()} loading={saving} disabled={!name.trim()} />
            <TextButton label="Cancel" onPress={onClose} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md, gap: theme.space.sm },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chipRow: { gap: theme.space.xs, paddingVertical: theme.space.xxs },
  chip: { minHeight: theme.touchTarget.min, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.sm, justifyContent: 'center' },
  listContent: { paddingHorizontal: theme.screen.edge, paddingBottom: theme.space.colossal, gap: theme.space.sm },
  group: { gap: theme.space.xxs, marginBottom: theme.space.md },
  customRow: { gap: theme.space.xxs },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md },
  trackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },
});
