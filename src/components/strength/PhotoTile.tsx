import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { LockGlyph } from '../LockGlyph';

type Props = {
  uri: string | null;
  label: string;
  /** Per-device "always reveal" opt-out (design doc CORE-16) — when true, the tile never blurs on this device. */
  alwaysReveal?: boolean;
  onPress?: () => void;
};

/**
 * PhotoTile — a progress-photo thumbnail, privacy-blurred by default (tap to
 * reveal), with a lock glyph (design doc CORE-16/health-data-compliance): a
 * glance at the phone in a gym never exposes body imagery. `alwaysReveal`
 * is a per-device, per-session opt-out, not a default.
 */
export function PhotoTile({ uri, label, alwaysReveal, onPress }: Props) {
  const [revealed, setRevealed] = useState(!!alwaysReveal);

  return (
    <Pressable
      onPress={() => {
        if (!revealed) {
          setRevealed(true);
          return;
        }
        onPress?.();
      }}
      accessibilityRole="button"
      accessibilityLabel={revealed ? `${label} photo` : `${label} photo, hidden. Tap to reveal.`}
      style={[styles.tile, { backgroundColor: theme.color.bg.inset }]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} blurRadius={revealed ? 0 : 40} accessibilityIgnoresInvertColors />
      ) : (
        <View style={StyleSheet.absoluteFill} />
      )}
      {!revealed && (
        <View style={styles.overlay}>
          <LockGlyph size={22} color={theme.color.text.primary} />
        </View>
      )}
      <Text style={[theme.type.overline, styles.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    aspectRatio: 3 / 4,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    padding: theme.space.xxs,
  },
});
