import React, { useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { SectionCard } from './SectionCard';
import { ConsentSheet } from '../consent/ConsentSheet';
import { TextButton } from '../TextButton';
import { useConsent, type CategoryState } from '../../state/ConsentContext';
import type { ConsentCategory } from '../../db/types';

const REVOKE_COPY: Record<ConsentCategory, { title: string; body: string }> = {
  health: {
    title: 'Turn off health data?',
    body: "MileLift will stop reading new health data. What you've already recorded stays.",
  },
  location: {
    title: 'Turn off location?',
    body: "Recording will stop mapping routes. What you've already saved stays.",
  },
  camera: {
    title: 'Turn off camera?',
    body: "You can still add progress photos from your library. What you've already saved stays.",
  },
};

const CATEGORY_LABEL: Record<ConsentCategory, string> = {
  health: 'Health',
  location: 'Location',
  camera: 'Camera',
};

/** screens-phase-0.md §F.5 — one row per consent category with graceful revoke. */
export function PermissionsSection() {
  const { categories, grant, revoke } = useConsent();
  const [sheetCategory, setSheetCategory] = useState<ConsentCategory | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);

  const handleToggleOn = (category: ConsentCategory) => {
    setSheetCategory(category);
  };

  const handleAllow = async () => {
    if (!sheetCategory) return;
    setSheetLoading(true);
    const result = await grant(sheetCategory);
    setSheetLoading(false);
    setSheetCategory(null);

    if (!result.ok && result.reason === 'os_blocked') {
      Alert.alert(
        `${CATEGORY_LABEL[sheetCategory]} is off in Settings`,
        'Open your phone Settings to allow this, then come back.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
    }
  };

  const handleToggleOff = (category: ConsentCategory) => {
    const copy = REVOKE_COPY[category];
    Alert.alert(copy.title, copy.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => void revoke(category) },
    ]);
  };

  return (
    <SectionCard title="Permissions & data">
      {(Object.keys(categories) as ConsentCategory[]).map((category) => (
        <PermissionRow
          key={category}
          category={category}
          state={categories[category]}
          onToggleOn={() => handleToggleOn(category)}
          onToggleOff={() => handleToggleOff(category)}
        />
      ))}

      {sheetCategory && (
        <ConsentSheet
          visible
          category={sheetCategory}
          loading={sheetLoading}
          onAllow={handleAllow}
          onDecline={() => setSheetCategory(null)}
        />
      )}
    </SectionCard>
  );
}

function PermissionRow({
  category,
  state,
  onToggleOn,
  onToggleOff,
}: {
  category: ConsentCategory;
  state: CategoryState;
  onToggleOn: () => void;
  onToggleOff: () => void;
}) {
  const isGranted = !!state.consent;
  const isBlocked = !isGranted && state.osStatus === 'blocked';

  const chip = isGranted
    ? { label: 'On', fg: theme.color.feedback.success, bg: theme.color.feedback.successTint }
    : isBlocked
      ? { label: 'Off in Settings', fg: theme.color.feedback.warning, bg: theme.color.feedback.warningTint }
      : { label: 'Off', fg: theme.color.text.tertiary, bg: theme.color.bg.inset };

  return (
    <View style={styles.row}>
      <Text style={[theme.type.body, { color: theme.color.text.primary }]}>{CATEGORY_LABEL[category]}</Text>
      <View style={styles.rowActions}>
        <View style={[styles.chip, { backgroundColor: chip.bg }]}>
          <Text style={[theme.type.caption, { color: chip.fg }]}>{chip.label}</Text>
        </View>
        {isBlocked ? (
          <TextButton label="Open Settings" onPress={() => void Linking.openSettings()} />
        ) : isGranted ? (
          <TextButton label="Turn off" onPress={onToggleOff} />
        ) : (
          <TextButton label="Turn on" onPress={onToggleOn} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: theme.touchTarget.min,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  chip: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xxs,
  },
});
