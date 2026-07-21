import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { theme } from '../../theme';
import { formatDuration } from '../../lib/format';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { REST_ADJUST_SECONDS } from '../../features/strength/useWorkoutEngine';
import type { RestTimerState } from '../../features/strength/useWorkoutEngine';

type Props = {
  state: RestTimerState;
  onAdjust: (deltaSeconds: number) => void;
  onSkip: () => void;
  onDismiss: () => void;
};

/**
 * RestTimer — CORE-12 first-class between-sets countdown (design doc §A).
 * Horizontal track depletes right→left toward the origin. Non-color signal
 * at every state: the numeric readout + a text label, never color alone.
 * Pinned to the bottom action bar while running (thumb reach).
 */
export function RestTimer({ state, onAdjust, onSkip, onDismiss }: Props) {
  if (!state.running && !state.done) return null;

  const trackColor = state.done ? theme.color.restTimer.done : state.ending ? theme.color.restTimer.ending : theme.color.restTimer.fill;
  const progress = state.plannedSeconds > 0 ? Math.max(0, Math.min(1, state.remainingSeconds / state.plannedSeconds)) : 0;
  const label = state.done ? 'Rest done' : 'Rest';

  return (
    <View
      style={[styles.container, { backgroundColor: theme.color.bg.raised }]}
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`${label}, ${formatDuration(state.remainingSeconds)} remaining`}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.track, { backgroundColor: theme.color.restTimer.track }]}>
        <View style={[styles.fill, { backgroundColor: trackColor, width: `${progress * 100}%` }]} />
      </View>

      <View style={styles.row}>
        <View style={styles.readout}>
          <PulsingReadout ending={state.ending && !state.done}>{formatDuration(state.remainingSeconds)}</PulsingReadout>
          <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            {label}
          </Text>
        </View>

        {!state.done ? (
          <View style={styles.controls}>
            <TimerButton label="−15s" accessibilityLabel="Subtract 15 seconds" onPress={() => onAdjust(-REST_ADJUST_SECONDS)} />
            <TimerButton label="+15s" accessibilityLabel="Add 15 seconds" onPress={() => onAdjust(REST_ADJUST_SECONDS)} />
            <TimerButton label="Skip" accessibilityLabel="Skip rest" onPress={onSkip} />
          </View>
        ) : (
          <TimerButton label="Dismiss" accessibilityLabel="Dismiss rest done" onPress={onDismiss} />
        )}
      </View>
    </View>
  );
}

/**
 * The final ~10s numeric readout (design doc §CORE-12 "Rest timer": "the
 * number pulses; reduced motion: no pulse, color + label change only"). The
 * color/label change (`restTimer.ending` gold + the `ending` state driving
 * the track fill above) already happens unconditionally; ONLY the animated
 * pulse itself is reduced-motion-gated here.
 */
function PulsingReadout({ ending, children }: { ending: boolean; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (ending && !reducedMotion) {
      pulse.value = withRepeat(withSequence(withTiming(1.08, { duration: theme.duration.base, easing: Easing.out(Easing.cubic) }), withTiming(1, { duration: theme.duration.base, easing: Easing.in(Easing.cubic) })), -1, false);
    } else {
      pulse.value = withTiming(1, { duration: theme.duration.fast });
    }
  }, [ending, reducedMotion, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  return (
    <Animated.Text
      style={[theme.type.metricLg, theme.fontVariation.metric, { color: theme.color.text.primary }, animatedStyle]}
      maxFontSizeMultiplier={1.6}
    >
      {children}
    </Animated.Text>
  );
}

function TimerButton({ label, accessibilityLabel, onPress }: { label: string; accessibilityLabel: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.button, { backgroundColor: theme.color.bg.inset }, pressed && { opacity: theme.opacity.pressed }]}
    >
      <Text style={[theme.type.label, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: theme.radius.lg,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    flexDirection: 'row-reverse', // depletes right -> left toward the origin
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  readout: {
    gap: 2,
  },
  controls: {
    flexDirection: 'row',
    gap: theme.space.xs,
  },
  button: {
    minHeight: theme.touchTarget.min,
    minWidth: theme.touchTarget.min,
    paddingHorizontal: theme.space.sm,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
