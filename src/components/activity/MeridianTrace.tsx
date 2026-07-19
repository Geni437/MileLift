import React, { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Path, Line } from 'react-native-svg';
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { theme } from '../../theme';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type MeridianTraceVariant = 'live' | 'static' | 'empty';

type Props = {
  variant: MeridianTraceVariant;
  /** 0..1 — for `live`, how far along the trace has drawn. Caller computes this (e.g. from elapsed time against a soft reference window) so this component owns rendering only, not recording-domain time math. */
  progress?: number;
  /** Normalized 0..1 sample series (pace or elevation) plotted as the baseline's vertical undulation. */
  series?: number[];
  /** 0..1 x-positions where a split notch + label should drop. */
  splitMarkers?: { position: number; label: string }[];
  height?: number;
  /** Smaller sizing for the ActivityRow micro-thumbnail. */
  compact?: boolean;
};

const DEFAULT_HEIGHT = 64;
const COMPACT_HEIGHT = 28;

/**
 * MeridianTrace — the app's signature applied to activity (component
 * vocabulary §A). A horizontal ember stroke anchored at a left origin dot:
 * `live` grows in real time with split notches; `static` renders a finished
 * activity's pace/elevation profile as a compact sparkline; `empty` is a
 * flat faint baseline + origin only. Reduced motion: `live` still updates
 * its endpoint (it's data) but without draw easing; `static` renders
 * complete immediately.
 */
export function MeridianTrace({ variant, progress = 0, series, splitMarkers, height, compact }: Props) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const drawn = useSharedValue(variant === 'static' ? 1 : 0);

  const boxHeight = height ?? (compact ? COMPACT_HEIGHT : DEFAULT_HEIGHT);
  const originX = 4;
  const endX = Math.max(originX + 1, width - 4);
  const midY = boxHeight / 2;

  useEffect(() => {
    const target = variant === 'empty' ? 0 : variant === 'static' ? 1 : Math.max(0, Math.min(1, progress));
    if (reducedMotion || variant !== 'live') {
      drawn.value = target;
      return;
    }
    drawn.value = withTiming(target, { duration: theme.duration.base, easing: Easing.out(Easing.cubic) });
  }, [variant, progress, reducedMotion, drawn]);

  function pathForSeries(): string {
    if (!series || series.length < 2 || width === 0) {
      return `M ${originX} ${midY} L ${endX} ${midY}`;
    }
    const amplitude = boxHeight * 0.32;
    const step = (endX - originX) / (series.length - 1);
    const points = series.map((value, i) => {
      const x = originX + step * i;
      const y = midY - (value - 0.5) * amplitude * 2;
      return `${x} ${y}`;
    });
    return `M ${points.join(' L ')}`;
  }

  const staticPath = pathForSeries();

  const label =
    variant === 'live'
      ? 'Route trace, updating live'
      : variant === 'static'
        ? 'Activity pace and elevation profile'
        : 'No route data yet';

  return (
    <View
      style={[styles.container, { height: boxHeight }]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      {width > 0 && (
        <Svg width={width} height={boxHeight}>
          {/* Baseline (empty / not-yet-drawn portion) */}
          <Line
            x1={originX}
            y1={midY}
            x2={endX}
            y2={midY}
            stroke={theme.color.border.subtle}
            strokeWidth={2}
            strokeOpacity={variant === 'empty' ? 0.6 : 0.35}
          />

          {variant === 'static' ? (
            <Path d={staticPath} stroke={theme.color.accent.primary} strokeWidth={compact ? 2 : 3} fill="none" strokeLinecap="round" />
          ) : variant === 'live' ? (
            <LiveEmberLine originX={originX} endX={endX} midY={midY} drawn={drawn} />
          ) : null}

          {variant !== 'empty' &&
            splitMarkers?.map((marker, i) => {
              const x = originX + (endX - originX) * Math.max(0, Math.min(1, marker.position));
              return (
                <Line
                  key={i}
                  x1={x}
                  y1={midY - 6}
                  x2={x}
                  y2={midY + 6}
                  stroke={theme.color.border.strong}
                  strokeWidth={2}
                />
              );
            })}

          <Circle cx={originX} cy={midY} r={compact ? 2.5 : 4} fill={theme.color.text.primary} fillOpacity={variant === 'empty' ? 0.5 : 1} />
        </Svg>
      )}
    </View>
  );
}

/** Isolated so the shared-value hook usage stays a fixed call order regardless of parent branch. */
function LiveEmberLine({
  originX,
  endX,
  midY,
  drawn,
}: {
  originX: number;
  endX: number;
  midY: number;
  drawn: SharedValue<number>;
}) {
  const animatedProps = useAnimatedProps(() => ({
    x2: originX + (endX - originX) * drawn.value,
  }));

  return (
    <AnimatedLine
      x1={originX}
      y1={midY}
      y2={midY}
      animatedProps={animatedProps}
      stroke={theme.color.accent.primary}
      strokeWidth={3}
      strokeLinecap="round"
    />
  );
}

const AnimatedLine = Animated.createAnimatedComponent(Line);

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
});
