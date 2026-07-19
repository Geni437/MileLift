import React, { useEffect } from 'react';
import { StyleSheet, type DimensionValue } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { theme } from '../theme';
import { useReducedMotion } from '../hooks/useReducedMotion';

type Props = {
  height?: number;
  width?: DimensionValue;
  radius?: number;
};

/**
 * Loading-state placeholder ("skeleton rows, not a blank screen" —
 * screens-phase-0.md §F Loading state). Pulses opacity gently; static under
 * reduced motion.
 */
export function SkeletonBlock({ height = 20, width = '100%', radius = theme.radius.sm }: Props) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 0.5;
      return;
    }
    opacity.value = withRepeat(withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [reducedMotion, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        styles.base,
        { height, width, borderRadius: radius, backgroundColor: theme.color.bg.raised },
        animatedStyle,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

const styles = StyleSheet.create({
  base: {},
});
