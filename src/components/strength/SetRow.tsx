import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from '../../theme';
import { SetTypeTag } from './SetTypeTag';
import { PrBadge } from '../activity/PrBadge';
import { displayWeightToKg, formatDuration, formatReps, formatWeightValue } from '../../lib/format';
import type { ExerciseFieldFlags, LocalWorkoutSet, UnitWeightSnapshot } from '../../db/types';

type Props = {
  set: LocalWorkoutSet;
  fieldFlags: ExerciseFieldFlags;
  unitWeight: UnitWeightSnapshot;
  previous: LocalWorkoutSet | null;
  /** This set beat a cached strength record (design doc §CORE-12 "the completion moment") — renders the inline "New best" `PrBadge`. */
  isPr?: boolean;
  onChange: (partial: Partial<Pick<LocalWorkoutSet, 'reps' | 'weightKg' | 'durationSeconds' | 'distanceM'>>) => void;
  onComplete: () => void;
  onUncomplete: () => void;
  onRemove: () => void;
};

/**
 * SetRow — one set within an `ExerciseBlock` (design doc §A). Columns are a
 * function of the exercise's metadata, never hardcoded. The complete toggle
 * IS the signature moment (§CORE-12): tapping locks the row's values,
 * flips a cyan left-border, and fills the toggle with a check glyph — the
 * non-color signal a screen-reader/sunlight-glare user still gets even
 * without perceiving the color change.
 */
export function SetRow({ set, fieldFlags, unitWeight, previous, isPr = false, onChange, onComplete, onUncomplete, onRemove }: Props) {
  const locked = set.isCompleted;
  const isWarmup = set.setType === 'warmup';

  const prevLabel = previous
    ? fieldFlags.isDistanceBased
      ? `${previous.distanceM ?? '--'}m`
      : fieldFlags.isTimeBased
        ? formatDuration(previous.durationSeconds)
        : `${formatWeightValue(previous.weightKg, unitWeight)}×${formatReps(previous.reps)}`
    : '—';

  return (
    <View
      style={[
        styles.row,
        locked && { borderLeftColor: theme.color.accent.data, borderLeftWidth: 3 },
        isWarmup && !locked && { opacity: 0.7 },
      ]}
    >
      <View style={styles.indexCol}>
        <SetTypeTag setType={set.setType} setNumber={set.setNumber} />
      </View>

      <Text
        // text.tertiary never clears AA at normal caption size (tokens.md
        // §"Contrast" — 4.15:1, large/UI text only) — text.secondary here,
        // same fix already applied to StrengthRecordRow/WorkoutRow/SyncStatusPill.
        style={[theme.type.caption, theme.fontVariation.metric, { color: theme.color.text.secondary }]}
        maxFontSizeMultiplier={1.6}
        numberOfLines={1}
        accessibilityLabel={`Previous: ${prevLabel}`}
      >
        {prevLabel}
      </Text>

      <View style={styles.fields}>
        {fieldFlags.isDistanceBased ? (
          <>
            <NumField label="Distance (m)" value={set.distanceM} locked={locked} onChangeValue={(v) => onChange({ distanceM: v })} />
            <NumField label="Time (s)" value={set.durationSeconds} locked={locked} onChangeValue={(v) => onChange({ durationSeconds: v })} />
          </>
        ) : fieldFlags.isTimeBased ? (
          <NumField label="Time (s)" value={set.durationSeconds} locked={locked} onChangeValue={(v) => onChange({ durationSeconds: v })} />
        ) : (
          <>
            {(fieldFlags.isWeighted || fieldFlags.isBodyweight) && (
              <NumField
                label={`Weight (${unitWeight})`}
                value={set.weightKg != null ? Number(formatWeightValue(set.weightKg, unitWeight)) : null}
                locked={locked}
                // The field shows/edits the DISPLAY unit (kg or lb); the
                // stored value is always canonical kg (architecture §1's
                // canonical-unit rule) — convert back on every commit so a
                // user on lb never has an lb number silently stored as kg.
                onChangeValue={(v) => onChange({ weightKg: v != null ? displayWeightToKg(v, unitWeight) : null })}
              />
            )}
            <NumField label="Reps" value={set.reps} locked={locked} onChangeValue={(v) => onChange({ reps: v != null ? Math.round(v) : null })} />
          </>
        )}
      </View>

      {isPr && <PrBadge label="New best" />}

      <Pressable
        onPress={locked ? onUncomplete : onComplete}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: locked }}
        accessibilityLabel={locked ? 'Completed set. Tap to edit.' : 'Mark set complete'}
        style={({ pressed }) => [
          styles.toggle,
          { borderColor: theme.color.border.default, backgroundColor: locked ? theme.color.accent.data : 'transparent' },
          pressed && { opacity: theme.opacity.pressed },
        ]}
      >
        {locked && (
          <Text style={{ color: theme.color.text.onAccent, fontWeight: '700' }} maxFontSizeMultiplier={1.4}>
            ✓
          </Text>
        )}
      </Pressable>

      {!locked && (
        <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel="Remove set" hitSlop={8} style={styles.removeButton}>
          <Text style={{ color: theme.color.text.tertiary }}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

function NumField({ label, value, locked, onChangeValue }: { label: string; value: number | null; locked: boolean; onChangeValue: (v: number | null) => void }) {
  const [text, setText] = useState(value != null ? String(value) : '');

  return (
    <View style={styles.field}>
      <TextInput
        value={locked ? (value != null ? String(value) : '--') : text}
        onChangeText={setText}
        onBlur={() => {
          const parsed = text.trim() === '' ? null : Number(text);
          onChangeValue(parsed != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null);
        }}
        editable={!locked}
        keyboardType="decimal-pad"
        accessibilityLabel={label}
        placeholder="0"
        placeholderTextColor={theme.color.text.tertiary}
        maxFontSizeMultiplier={1.6}
        style={[
          theme.type.metricMd,
          theme.fontVariation.metric,
          styles.input,
          { color: locked ? theme.color.text.secondary : theme.color.text.primary, borderColor: theme.color.border.subtle },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    paddingVertical: theme.space.xs,
    paddingHorizontal: theme.space.xs,
    minHeight: theme.touchTarget.comfortable,
  },
  indexCol: {
    width: 36,
    alignItems: 'center',
  },
  fields: {
    flex: 1,
    flexDirection: 'row',
    gap: theme.space.xs,
  },
  field: {
    minWidth: 56,
  },
  input: {
    borderBottomWidth: theme.border.hairline,
    paddingVertical: theme.space.xxs,
    textAlign: 'center',
    minHeight: theme.touchTarget.min,
  },
  toggle: {
    width: theme.touchTarget.min,
    height: theme.touchTarget.min,
    borderRadius: theme.radius.sm,
    borderWidth: theme.border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButton: {
    width: theme.touchTarget.min,
    height: theme.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
