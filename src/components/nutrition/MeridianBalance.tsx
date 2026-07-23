import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { theme } from '../../theme';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type MeridianBalanceVariant = 'live' | 'static' | 'empty';

type Props = {
  variant: MeridianBalanceVariant;
  /** Calories in today (>= 0). */
  intakeKcal: number;
  /** Calories out today, as a positive magnitude (>= 0). */
  expenditureKcal: number;
  beamHeight?: number;
};

const DEFAULT_LIVE_BEAM_HEIGHT = 56;
const DEFAULT_STATIC_BEAM_HEIGHT = 22;
/** Masses never fill the whole half-track — leaves visual room for the origin dot to read as "resting," not "capped." */
const MASS_FILL_RATIO = 0.86;

/**
 * MeridianBalance — the Phase 3 signature (design doc §0/§A): the Meridian
 * ORIGIN made a working instrument, the counterpart to `MeridianTrace` (Mile
 * axis) and `LiftStack` (Lift axis). A horizontal beam anchored at CENTER
 * (deliberately not a left edge, unlike `MeridianTrace` — this is a
 * *balance*, not a *growth*): the intake mass (ember) accretes on the warm
 * (right) side, the expenditure mass (cyan) on the cool (left) side, and the
 * origin dot's OFFSET from the geometric center is the net — literally
 * "where the origin rests." No goal marker, no fill-to-100% (§12 decision
 * 5 — there is no target in Phase 3).
 *
 * Height mapping is a documented, self-normalizing simplification (no
 * design-system pixel-exact spec given), the same class of judgment call
 * `LiftStack`'s own doc comment makes: each mass's length is proportional to
 * its own value relative to `max(intake, expenditure, 1)` — a living balance
 * scaled to itself, not to any fixed target.
 */
export function MeridianBalance({ variant, intakeKcal, expenditureKcal, beamHeight }: Props) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const netKcal = intakeKcal - expenditureKcal;
  const boxHeight = beamHeight ?? (variant === 'static' ? DEFAULT_STATIC_BEAM_HEIGHT : DEFAULT_LIVE_BEAM_HEIGHT);

  const maxSide = Math.max(intakeKcal, expenditureKcal, 1);
  const intakeRatio = variant === 'empty' ? 0 : (intakeKcal / maxSide) * MASS_FILL_RATIO;
  const expenditureRatio = variant === 'empty' ? 0 : (expenditureKcal / maxSide) * MASS_FILL_RATIO;
  const originOffsetRatio = variant === 'empty' ? 0 : (netKcal / maxSide) * MASS_FILL_RATIO;

  const intakeGrow = useSharedValue(reducedMotion || variant === 'static' ? intakeRatio : 0);
  const expenditureGrow = useSharedValue(reducedMotion || variant === 'static' ? expenditureRatio : 0);
  const originOffset = useSharedValue(reducedMotion || variant === 'static' ? originOffsetRatio : 0);

  useEffect(() => {
    if (reducedMotion) {
      intakeGrow.value = intakeRatio;
      expenditureGrow.value = expenditureRatio;
      originOffset.value = originOffsetRatio;
      return;
    }
    intakeGrow.value = withTiming(intakeRatio, { duration: theme.duration.base, easing: Easing.out(Easing.cubic) });
    expenditureGrow.value = withTiming(expenditureRatio, { duration: theme.duration.base, easing: Easing.out(Easing.cubic) });
    // The origin re-settle is the earned moment (design doc "Motion" note) —
    // a spring, not a linear timing curve.
    originOffset.value = withSpring(originOffsetRatio, theme.spring.settle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intakeRatio, expenditureRatio, originOffsetRatio, reducedMotion]);

  const intakeStyle = useAnimatedStyle(() => ({ width: `${Math.max(0, intakeGrow.value) * 50}%` }));
  const expenditureStyle = useAnimatedStyle(() => ({ width: `${Math.max(0, expenditureGrow.value) * 50}%` }));
  const originStyle = useAnimatedStyle(() => ({ left: `${50 + originOffset.value * 50}%` }));

  const netLabel = netKcal >= 0 ? `+${Math.round(netKcal)}` : `${Math.round(netKcal)}`;
  const a11yLabel = `In ${Math.round(intakeKcal)} · Out ${Math.round(expenditureKcal)} · Net ${netLabel} kcal`;

  return (
    <View style={styles.wrap} accessible accessibilityRole="text" accessibilityLabel={a11yLabel}>
      {variant === 'live' && (
        <View style={styles.netLabelWrap} pointerEvents="none" accessibilityElementsHidden>
          <Text style={[theme.type.metricLg, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.4}>
            {netLabel}
          </Text>
          <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            NET KCAL
          </Text>
        </View>
      )}

      <View style={[styles.beam, { height: boxHeight }]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        <View style={[styles.track, { backgroundColor: theme.color.energyBalance.track }]} />

        {width > 0 && variant !== 'empty' && (
          <>
            {/* Expenditure mass — cyan, grows LEFT from center. */}
            <Animated.View style={[styles.massRight, expenditureStyle, { backgroundColor: theme.color.energyBalance.expenditure, right: '50%' }]} />
            {/* Intake mass — ember, grows RIGHT from center. */}
            <Animated.View style={[styles.massLeft, intakeStyle, { backgroundColor: theme.color.energyBalance.intake, left: '50%' }]} />
          </>
        )}

        <View style={[styles.centerTick, { backgroundColor: theme.color.border.strong }]} />
        <Animated.View style={[styles.origin, originStyle, { backgroundColor: theme.color.energyBalance.origin }]} />
      </View>

      {variant === 'live' && (
        <View style={styles.sideLabelsRow} pointerEvents="none" accessibilityElementsHidden>
          <View style={styles.sideLabelCol}>
            <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              OUT
            </Text>
            <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              {Math.round(expenditureKcal)}
            </Text>
          </View>
          <View style={[styles.sideLabelCol, styles.sideLabelColEnd]}>
            <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              IN
            </Text>
            <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              {Math.round(intakeKcal)}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const MASS_HEIGHT = '60%';
const MASS_RADIUS = theme.radius.sm;

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    gap: theme.space.xxs,
  },
  netLabelWrap: {
    alignItems: 'center',
  },
  beam: {
    width: '100%',
    justifyContent: 'center',
    position: 'relative',
  },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    top: '50%',
    marginTop: -1,
    borderRadius: 1,
  },
  massLeft: {
    position: 'absolute',
    top: '50%',
    marginTop: -9,
    height: MASS_HEIGHT,
    minHeight: 8,
    borderTopRightRadius: MASS_RADIUS,
    borderBottomRightRadius: MASS_RADIUS,
  },
  massRight: {
    position: 'absolute',
    top: '50%',
    marginTop: -9,
    height: MASS_HEIGHT,
    minHeight: 8,
    borderTopLeftRadius: MASS_RADIUS,
    borderBottomLeftRadius: MASS_RADIUS,
  },
  centerTick: {
    position: 'absolute',
    left: '50%',
    marginLeft: -0.5,
    top: '15%',
    bottom: '15%',
    width: 1,
    opacity: 0.5,
  },
  origin: {
    position: 'absolute',
    top: '50%',
    marginTop: -5,
    marginLeft: -5,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  sideLabelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sideLabelCol: {
    gap: 2,
    alignItems: 'flex-start',
  },
  sideLabelColEnd: {
    alignItems: 'flex-end',
  },
});
