import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { theme } from '../theme';

type Props = {
  size?: number;
  color?: string;
};

/**
 * A drawn (not emoji, not a third-party icon font) lock glyph — the
 * "protection, not a feature" visual language for the `body_image` consent
 * category (design doc CORE-16: "styled deliberately without a bright brand
 * accent ... a lock glyph") and the privacy-blurred `PhotoTile` default
 * state. Reuses the same plain-SVG-shape discipline as `MeridianMark`
 * (component vocabulary §A) — no new icon set introduced.
 */
export function LockGlyph({ size = 20, color }: Props) {
  const stroke = color ?? theme.color.text.primary;
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Rect x={5} y={11} width={14} height={10} rx={2} stroke={stroke} strokeWidth={2} />
        <Path d="M8 11V7a4 4 0 0 1 8 0v4" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
      </Svg>
    </View>
  );
}
