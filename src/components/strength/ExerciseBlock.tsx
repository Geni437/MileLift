import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../theme';
import { MuscleTag } from './MuscleTag';
import { SetRow } from './SetRow';
import { TextButton } from '../TextButton';
import { ConfirmSheet } from '../ConfirmSheet';
import type { ExerciseBlockState } from '../../features/strength/useWorkoutEngine';
import type { LocalWorkoutSet, UnitWeightSnapshot } from '../../db/types';

type Props = {
  block: ExerciseBlockState;
  unitWeight: UnitWeightSnapshot;
  isFirst: boolean;
  isLast: boolean;
  onChangeSet: (setId: string, partial: Partial<Pick<LocalWorkoutSet, 'reps' | 'weightKg' | 'durationSeconds' | 'distanceM'>>) => void;
  onCompleteSet: (setId: string) => void;
  onUncompleteSet: (setId: string) => void;
  onRemoveSet: (setId: string) => void;
  onAddSet: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemoveExercise: () => void;
};

/**
 * ExerciseBlock — one exercise within the active session (design doc §A).
 * Header: thumbnail-less (offline-safe: name + MuscleTag only, no network
 * dependency for the logging path), an overflow menu carrying Reorder
 * (Move up/down — the REQUIRED accessible alternative to drag, §CORE-12; a
 * drag handle is a nice-to-have not built in this pass, flagged in the
 * task report) and Remove exercise (names the consequence when sets are
 * already completed, per the destructive-action rule).
 */
export function ExerciseBlock({ block, unitWeight, isFirst, isLast, onChangeSet, onCompleteSet, onUncompleteSet, onRemoveSet, onAddSet, onMoveUp, onMoveDown, onRemoveExercise }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const completedCount = block.sets.filter((s) => s.isCompleted && s.setType === 'working').length;
  const previousByNumber = new Map(block.previousSets.map((s) => [s.setNumber, s]));

  return (
    <View style={[styles.container, { borderColor: theme.color.border.subtle }]}>
      <View style={styles.header}>
        <View style={styles.titleColumn}>
          <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} numberOfLines={1} maxFontSizeMultiplier={1.8}>
            {block.exerciseNameSnapshot}
          </Text>
          {block.primaryMuscleSnapshot && <MuscleTag muscle={block.primaryMuscleSnapshot} />}
        </View>
        <Pressable onPress={() => setMenuOpen(true)} accessibilityRole="button" accessibilityLabel="Exercise options" hitSlop={8} style={styles.overflowButton}>
          <Text style={{ color: theme.color.text.secondary, fontSize: 20 }}>⋯</Text>
        </Pressable>
      </View>

      {block.sets.map((set) => (
        <SetRow
          key={set.id}
          set={set}
          fieldFlags={block.fieldFlags}
          unitWeight={unitWeight}
          previous={previousByNumber.get(set.setNumber) ?? null}
          onChange={(partial) => onChangeSet(set.id, partial)}
          onComplete={() => onCompleteSet(set.id)}
          onUncomplete={() => onUncompleteSet(set.id)}
          onRemove={() => onRemoveSet(set.id)}
        />
      ))}

      <TextButton label="+ Add set" onPress={onAddSet} />

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]} onPress={() => setMenuOpen(false)} accessibilityLabel="Dismiss" accessibilityRole="button">
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
              <MenuRow label="Move up" disabled={isFirst} onPress={() => { setMenuOpen(false); onMoveUp(); }} />
              <MenuRow label="Move down" disabled={isLast} onPress={() => { setMenuOpen(false); onMoveDown(); }} />
              <MenuRow
                label="Remove exercise"
                tone="danger"
                onPress={() => {
                  setMenuOpen(false);
                  setConfirmRemove(true);
                }}
              />
              <TextButton label="Cancel" onPress={() => setMenuOpen(false)} />
            </View>
          </SafeAreaView>
        </Pressable>
      </Modal>

      <ConfirmSheet
        visible={confirmRemove}
        title={`Remove ${block.exerciseNameSnapshot}?`}
        body={
          completedCount > 0
            ? `Remove ${block.exerciseNameSnapshot} and its ${completedCount} logged ${completedCount === 1 ? 'set' : 'sets'}? The sets are deleted from this workout.`
            : `Remove ${block.exerciseNameSnapshot} from this workout?`
        }
        confirmLabel="Remove"
        onConfirm={() => {
          setConfirmRemove(false);
          onRemoveExercise();
        }}
        onCancel={() => setConfirmRemove(false)}
      />
    </View>
  );
}

function MenuRow({ label, tone, disabled, onPress }: { label: string; tone?: 'danger'; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.menuRow, pressed && !disabled && { opacity: theme.opacity.pressed }]}
    >
      <Text
        style={[theme.type.body, { color: disabled ? theme.color.text.disabled : tone === 'danger' ? theme.color.feedback.danger : theme.color.text.primary }]}
        maxFontSizeMultiplier={1.8}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: theme.border.hairline,
    borderRadius: theme.radius.lg,
    padding: theme.space.sm,
    gap: theme.space.xxs,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: theme.space.xs,
  },
  titleColumn: {
    flex: 1,
    gap: theme.space.xxs,
  },
  overflowButton: {
    width: theme.touchTarget.min,
    height: theme.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    width: '100%',
  },
  sheet: {
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  menuRow: {
    minHeight: theme.touchTarget.min,
    justifyContent: 'center',
  },
});
