import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { TextButton } from '../../../src/components/TextButton';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { EmptyState } from '../../../src/components/EmptyState';
import { PhotoTile } from '../../../src/components/strength/PhotoTile';
import { progressPhotosRepository } from '../../../src/db/repositories/progressPhotosRepository';
import { localPreferencesRepository } from '../../../src/db/repositories/localPreferencesRepository';
import { formatRelativeDateTime } from '../../../src/lib/format';
import { useAuth } from '../../../src/state/AuthContext';
import type { LocalProgressPhoto, PhotoPose } from '../../../src/db/types';

const POSES: PhotoPose[] = ['front', 'side', 'back'];

/** CORE-16 compare view — same-pose-over-time, two dates side by side. */
export default function ProgressPhotosCompareScreen() {
  const { userId } = useAuth();
  const [occasions, setOccasions] = useState<LocalProgressPhoto[]>([]);
  const [pose, setPose] = useState<PhotoPose>('front');
  const [leftIndex, setLeftIndex] = useState(1);
  const [rightIndex, setRightIndex] = useState(0);
  const [alwaysReveal, setAlwaysReveal] = useState(false);

  useEffect(() => {
    if (!userId) return;
    void progressPhotosRepository.listForUser(userId).then(setOccasions);
    void localPreferencesRepository.get(userId).then((prefs) => setAlwaysReveal(prefs.photosAlwaysReveal));
  }, [userId]);

  const withPose = occasions.filter((o) => o.images.some((i) => i.pose === pose));

  if (withPose.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.headerRow}>
          <TextButton label="Back" onPress={() => router.back()} />
        </View>
        <EmptyState title="No photos with this pose yet." body="Add a progress photo to start comparing over time." />
      </SafeAreaView>
    );
  }

  const left = withPose[Math.min(leftIndex, withPose.length - 1)];
  const right = withPose[Math.min(rightIndex, withPose.length - 1)];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TextButton label="Back" onPress={() => router.back()} />
        </View>
        <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          Compare
        </Text>
        <SegmentedControl options={POSES.map((p) => ({ label: p, value: p }))} value={pose} onChange={setPose} />

        <View style={styles.compareRow}>
          <CompareColumn
            occasion={right}
            pose={pose}
            alwaysReveal={alwaysReveal}
            onOlder={() => setRightIndex((i) => Math.min(withPose.length - 1, i + 1))}
            onNewer={() => setRightIndex((i) => Math.max(0, i - 1))}
          />
          <CompareColumn
            occasion={left}
            pose={pose}
            alwaysReveal={alwaysReveal}
            onOlder={() => setLeftIndex((i) => Math.min(withPose.length - 1, i + 1))}
            onNewer={() => setLeftIndex((i) => Math.max(0, i - 1))}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CompareColumn({
  occasion,
  pose,
  alwaysReveal,
  onOlder,
  onNewer,
}: {
  occasion: LocalProgressPhoto | undefined;
  pose: PhotoPose;
  alwaysReveal: boolean;
  onOlder: () => void;
  onNewer: () => void;
}) {
  if (!occasion) return <View style={styles.column} />;
  const image = occasion.images.find((i) => i.pose === pose);
  return (
    <View style={styles.column}>
      <PhotoTile uri={image?.localUri ?? null} label={pose} alwaysReveal={alwaysReveal} />
      <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
        {formatRelativeDateTime(occasion.occurredAt)}
      </Text>
      <View style={styles.navRow}>
        <TextButton label="◂ Older" onPress={onOlder} />
        <TextButton label="Newer ▸" onPress={onNewer} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.md },
  headerRow: { flexDirection: 'row' },
  compareRow: { flexDirection: 'row', gap: theme.space.md },
  column: { flex: 1, gap: theme.space.xs },
  navRow: { flexDirection: 'row', justifyContent: 'space-between' },
});
