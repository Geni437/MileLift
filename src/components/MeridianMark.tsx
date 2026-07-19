import React, { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { theme } from '../theme';
import { useReducedMotion } from '../hooks/useReducedMotion';

const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type MeridianVariant = 'lockup' | 'progress' | 'glyph' | 'seed';

type Props = {
  variant: MeridianVariant;
  /** For `variant="progress"`: 0 = not started, 1 = mile axis drawn, 2 = lift axis drawn (complete). Ignored for other variants. */
  progressStep?: 0 | 1 | 2;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

const VIEWBOX = 100;
const ORIGIN = { x: 30, y: 70 };
const MILE_END = { x: 88, y: 70 }; // horizontal, ember
const LIFT_END = { x: 30, y: 14 }; // vertical, cyan

/**
 * MeridianMark — the signature glyph (tokens.md §6, screens-phase-0.md §A).
 * Two strokes from a shared origin: horizontal Mile axis (ember), vertical
 * Lift axis (cyan). `glyph`/`lockup`/`seed` render fully drawn (a small
 * settle spring on mount); `progress` is driven by `progressStep` and is the
 * onboarding progress indicator (draws in response to step completion, not
 * on a timer).
 *
 * Reduced motion (tokens.md §5, screens-phase-0.md motion notes): axes
 * render immediately at final state, no stroke-draw animation — a crossfade
 * only.
 */
export function MeridianMark({ variant, progressStep = 2, size = 64, style }: Props) {
  const reducedMotion = useReducedMotion();
  const mileProgress = useSharedValue(0);
  const liftProgress = useSharedValue(0);
  const originScale = useSharedValue(variant === 'progress' ? 0.4 : 1);

  const targetStep = variant === 'progress' ? progressStep : variant === 'seed' ? 0 : 2;
  const isSeed = variant === 'seed';

  useEffect(() => {
    const mileTarget = targetStep >= 1 ? 1 : 0;
    const liftTarget = targetStep >= 2 ? 1 : 0;

    if (reducedMotion) {
      mileProgress.value = mileTarget;
      liftProgress.value = liftTarget;
      originScale.value = 1;
      return;
    }

    mileProgress.value = withTiming(mileTarget, { duration: theme.duration.deliberate, easing: Easing.out(Easing.cubic) });
    liftProgress.value = withDelay(
      mileTarget ? theme.duration.deliberate : 0,
      withTiming(liftTarget, { duration: theme.duration.deliberate, easing: Easing.out(Easing.cubic) })
    );
    if (liftTarget) {
      originScale.value = withDelay(
        theme.duration.deliberate * 2,
        withSpring(1, theme.spring.settle)
      );
    }
  }, [targetStep, reducedMotion, mileProgress, liftProgress, originScale]);

  const mileAnimatedProps = useAnimatedProps(() => ({
    x2: ORIGIN.x + (MILE_END.x - ORIGIN.x) * mileProgress.value,
    y2: ORIGIN.y + (MILE_END.y - ORIGIN.y) * mileProgress.value,
  }));

  const liftAnimatedProps = useAnimatedProps(() => ({
    x2: ORIGIN.x + (LIFT_END.x - ORIGIN.x) * liftProgress.value,
    y2: ORIGIN.y + (LIFT_END.y - ORIGIN.y) * liftProgress.value,
  }));

  const originAnimatedProps = useAnimatedProps(() => ({
    r: 2 + originScale.value * 1.5,
  }));

  const strokeOpacity = isSeed ? 0.35 : 1;

  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
        <AnimatedLine
          x1={ORIGIN.x}
          y1={ORIGIN.y}
          animatedProps={mileAnimatedProps}
          stroke={theme.color.accent.primary}
          strokeOpacity={strokeOpacity}
          strokeWidth={4}
          strokeLinecap="round"
        />
        <AnimatedLine
          x1={ORIGIN.x}
          y1={ORIGIN.y}
          animatedProps={liftAnimatedProps}
          stroke={theme.color.accent.data}
          strokeOpacity={strokeOpacity}
          strokeWidth={4}
          strokeLinecap="round"
        />
        <AnimatedCircle
          cx={ORIGIN.x}
          cy={ORIGIN.y}
          animatedProps={originAnimatedProps}
          fill={theme.color.text.primary}
          fillOpacity={isSeed ? 0.5 : 1}
        />
      </Svg>
    </View>
  );
}
