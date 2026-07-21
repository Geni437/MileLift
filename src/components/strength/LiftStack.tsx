import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { theme } from '../../theme';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type LiftStackSegment = {
  key: string;
  /** Volume (reps × weight_kg), or reps/duration for bodyweight/time movements — height ∝ this value (design doc §A). */
  volume: number;
  isPr: boolean;
};

type Props = {
  variant: 'live' | 'static' | 'empty';
  segments: LiftStackSegment[];
  /** The current exercise's prior best (est-1RM/heaviest) — renders as a faint horizontal tick, `live` variant only. */
  previousBestTickRatio?: number | null;
  height?: number;
};

/**
 * LiftStack — the Phase 2 signature (design doc §0/§A): a vertical cyan
 * column anchored at a bottom origin dot, the Lift axis raised by completed
 * WORKING sets. `live` is a slim rail (peripheral during logging, per
 * §Decisions item 1); `static` is the large hero on the Save sheet/session
 * detail/history row. A PR segment flares ember and rises past the
 * previous-best tick — no new color, reuses `accent.primary` exactly as
 * `MeridianTrace` does for its own PR language.
 *
 * Height mapping (a documented simplification, no design-system pixel-exact
 * spec given): each segment's height is proportional to its own volume
 * relative to the largest segment logged so far in this rendering — "a
 * living axis, not a fill-to-100% bar" per the design doc, so the scale is
 * relative/self-normalizing rather than against any fixed target.
 */
export function LiftStack({ variant, segments, previousBestTickRatio, height = 160 }: Props) {
  const maxVolume = Math.max(1, ...segments.map((s) => s.volume));

  return (
    <View style={[styles.container, { height, width: variant === 'live' ? 10 : '100%' }]} accessibilityElementsHidden={variant !== 'static'}>
      <View style={[styles.baseline, { backgroundColor: theme.color.border.subtle }]} />
      {variant !== 'empty' &&
        segments.map((segment, index) => (
          <LiftStackBar key={segment.key} segment={segment} ratio={segment.volume / maxVolume} isNewest={index === segments.length - 1} slim={variant === 'live'} />
        ))}
      {previousBestTickRatio != null && previousBestTickRatio > 0 && previousBestTickRatio <= 1 && (
        <View
          style={[styles.tick, { bottom: `${previousBestTickRatio * 100}%`, backgroundColor: theme.color.text.tertiary }]}
          accessibilityLabel="Previous best"
        />
      )}
      <View style={[styles.origin, { backgroundColor: theme.color.text.primary }]} />
    </View>
  );
}

function LiftStackBar({ segment, ratio, isNewest, slim }: { segment: LiftStackSegment; ratio: number; isNewest: boolean; slim: boolean }) {
  const reducedMotion = useReducedMotion();
  const rise = useSharedValue(reducedMotion || !isNewest ? 1 : 0);

  useEffect(() => {
    if (!reducedMotion && isNewest) {
      rise.value = withTiming(1, { duration: theme.duration.fast, easing: Easing.out(Easing.cubic) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.key]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: `${Math.max(4, ratio * 100) * rise.value}%`,
    opacity: rise.value,
  }));

  const color = segment.isPr ? theme.color.accent.primary : theme.color.accent.data;

  return (
    <Animated.View
      style={[
        slim ? styles.barSlim : styles.barWide,
        animatedStyle,
        { backgroundColor: color },
        segment.isPr && !reducedMotion ? styles.prGlow : null,
        segment.isPr && { shadowColor: theme.color.accent.primary },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'flex-end',
    alignItems: 'center',
    position: 'relative',
  },
  baseline: {
    position: 'absolute',
    bottom: 0,
    width: 1,
    height: '100%',
  },
  barSlim: {
    width: 6,
    borderRadius: 3,
    marginBottom: 1,
  },
  barWide: {
    width: '70%',
    borderRadius: theme.radius.sm,
    marginBottom: 2,
  },
  prGlow: {
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  tick: {
    position: 'absolute',
    width: '100%',
    height: 1,
  },
  origin: {
    position: 'absolute',
    bottom: -3,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
