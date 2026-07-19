import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { theme } from '../../theme';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type GpsSignalState = 'acquiring' | 'strong' | 'weak' | 'lost';

const CONFIG: Record<GpsSignalState, { label: string; bars: number; warning: boolean }> = {
  acquiring: { label: 'Acquiring…', bars: 1, warning: false },
  strong: { label: 'Strong', bars: 3, warning: false },
  weak: { label: 'Weak', bars: 2, warning: true },
  lost: { label: 'Lost', bars: 0, warning: true },
};

/**
 * GpsSignal — telemetry chip in `accent.data` (cyan). Color is never the
 * only signal: a text label + a 3-bar glyph carry the state, and a
 * warning-gold dot appears alongside (not instead of) cyan on weak/lost
 * (component vocabulary §A, CORE-01 "Weak / lost signal" state).
 */
export function GpsSignal({ state }: { state: GpsSignalState }) {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  const config = CONFIG[state];

  useEffect(() => {
    if (reducedMotion || state !== 'acquiring') {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [state, reducedMotion, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View
      style={[styles.chip, { backgroundColor: theme.color.accent.dataTint }]}
      accessible
      accessibilityLabel={`GPS signal: ${config.label}`}
      testID="gps-signal-chip"
    >
      <Animated.View style={[styles.bars, animatedStyle]}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[
              styles.bar,
              { height: 4 + i * 3 },
              { backgroundColor: i < config.bars ? theme.color.accent.data : theme.color.border.default },
            ]}
          />
        ))}
      </Animated.View>
      <Text style={[theme.type.label, { color: theme.color.accent.data }]} maxFontSizeMultiplier={1.6}>
        {config.label}
      </Text>
      {config.warning && <View style={[styles.warningDot, { backgroundColor: theme.color.feedback.warning }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xxs,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xxs,
    minHeight: theme.touchTarget.min,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },
  bar: {
    width: 3,
    borderRadius: 1,
  },
  warningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
