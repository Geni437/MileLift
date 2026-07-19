import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';

import { theme } from '../theme';

type Props = {
  /** 0-100, the "run" share. Lift share is 100 - value. */
  value: number;
  onChange: (value: number) => void;
};

const SNAP_POINTS = [
  { label: 'Endurance', value: 80 },
  { label: 'Balanced', value: 50 },
  { label: 'Strength', value: 20 },
];

/**
 * The Step-2 "training balance" interaction (screens-phase-0.md §D Step 2) —
 * a real accessible slider (adjustable role, screen-reader value
 * announcement, increment/decrement), not a drag-only custom control, with
 * tappable labeled snap points for users who'd rather tap than drag.
 *
 * IMPLEMENTATION NOTE: uses @react-native-community/slider's native thumb
 * for full platform accessibility support (VoiceOver/TalkBack adjustable
 * semantics come for free from the native control) rather than a hand-rolled
 * gesture-handler slider, which would have to reimplement that
 * accessibility behavior from scratch. The min/max track tint approximates
 * the spec's warm-ember/cool-cyan duality using the native two-tone track
 * (relative to thumb position) rather than a fixed SVG gradient — a
 * reasonable Phase 0 simplification; a fixed-gradient track is a pure
 * visual enhancement, not a functional gap, and can follow later.
 */
export function BalanceTrack({ value, onChange }: Props) {
  const liftShare = 100 - value;

  return (
    <View style={styles.container}>
      <View style={styles.readoutRow}>
        <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary }]}>
          {value} / {liftShare}
        </Text>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>run / lift</Text>
      </View>

      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={100}
        step={1}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={theme.color.accent.primary}
        maximumTrackTintColor={theme.color.accent.data}
        thumbTintColor={theme.color.text.primary}
        accessibilityLabel="Training balance"
        accessibilityHint="Adjust the balance between endurance and strength training."
        accessibilityValue={{ min: 0, max: 100, now: value, text: `${value} run, ${liftShare} lift` }}
      />

      <View style={styles.labelsRow}>
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]}>Endurance-leaning</Text>
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]}>Strength-leaning</Text>
      </View>

      <View style={styles.snapRow}>
        {SNAP_POINTS.map((snap) => (
          <Pressable
            key={snap.label}
            onPress={() => onChange(snap.value)}
            accessibilityRole="button"
            accessibilityLabel={`Set training balance to ${snap.label}`}
            style={({ pressed }) => [
              styles.snapChip,
              {
                borderColor: theme.color.border.default,
                backgroundColor: value === snap.value ? theme.color.bg.inset : 'transparent',
              },
              pressed && { opacity: theme.opacity.pressed },
            ]}
          >
            <Text style={[theme.type.label, { color: theme.color.text.primary }]}>{snap.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.sm,
  },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.xs,
  },
  slider: {
    width: '100%',
    height: theme.touchTarget.comfortable,
  },
  labelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  snapRow: {
    flexDirection: 'row',
    gap: theme.space.xs,
  },
  snapChip: {
    flex: 1,
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.pill,
    borderWidth: theme.border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space.xs,
  },
});
