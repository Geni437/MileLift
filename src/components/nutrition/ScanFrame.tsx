import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';

import { theme } from '../../theme';
import { TextButton } from '../TextButton';

type Props = {
  onBarcodeScanned: (barcode: string) => void;
  /** True while an in-flight lookup is resolving — shows an inline spinner on the reticle without blocking the live camera (design doc §CORE-07 "Resolving" state). */
  resolving?: boolean;
  onSearchInstead: () => void;
};

/** ScanFrame — the CORE-07 camera scan surface (design doc §A): a live camera preview with a Meridian-origin-cornered reticle, a torch toggle, and a "point at the barcode" hint. */
export function ScanFrame({ onBarcodeScanned, resolving, onSearchInstead }: Props) {
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(true);
  const [lastScannedAt, setLastScannedAt] = useState(0);

  const handleScan = (result: BarcodeScanningResult) => {
    // Debounce repeat detections of the same frame — the camera fires
    // onBarcodeScanned continuously while a code stays in frame.
    const now = Date.now();
    if (now - lastScannedAt < 1500) return;
    setLastScannedAt(now);
    if (result.data) onBarcodeScanned(result.data);
  };

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torchOn}
        barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'] }}
        onBarcodeScanned={handleScan}
        onCameraReady={() => setTorchAvailable(true)}
      />

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.reticleWrap} pointerEvents="none">
          <View style={styles.reticle}>
            <Corner style={styles.cornerTL} />
            <Corner style={styles.cornerTR} />
            <Corner style={styles.cornerBL} />
            <Corner style={styles.cornerBR} />
            {resolving && (
              <Text style={[theme.type.caption, styles.resolvingText, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
                Resolving…
              </Text>
            )}
          </View>
          <Text style={[theme.type.body, styles.hint, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
            Point at the barcode
          </Text>
        </View>

        <View style={styles.bottomRow}>
          {torchAvailable && (
            <Pressable
              onPress={() => setTorchOn((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={torchOn ? 'Turn off torch' : 'Turn on torch'}
              style={[styles.torchButton, { backgroundColor: theme.color.bg.overlay }]}
            >
              <Text style={[theme.type.label, { color: theme.color.text.primary }]}>{torchOn ? 'Torch on' : 'Torch off'}</Text>
            </Pressable>
          )}
          <TextButton label="Search instead" onPress={onSearchInstead} />
        </View>
      </View>
    </View>
  );
}

function Corner({ style }: { style: object }) {
  return <View style={[styles.cornerBase, { borderColor: theme.color.accent.primary }, style]} />;
}

const RETICLE_SIZE = 220;
const CORNER_LEN = 24;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.color.bg.canvas,
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    paddingVertical: theme.space.xxl,
  },
  reticleWrap: {
    alignItems: 'center',
    gap: theme.space.md,
    marginTop: theme.space.giant,
  },
  reticle: {
    width: RETICLE_SIZE,
    height: RETICLE_SIZE * 0.6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cornerBase: {
    position: 'absolute',
    width: CORNER_LEN,
    height: CORNER_LEN,
    borderWidth: 3,
  },
  cornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
  cornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
  cornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
  cornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },
  resolvingText: {},
  hint: {
    textAlign: 'center',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.screen.edge,
  },
  torchButton: {
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    justifyContent: 'center',
  },
});
