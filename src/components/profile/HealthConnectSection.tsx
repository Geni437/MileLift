import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { SectionCard } from './SectionCard';
import { TextButton } from '../TextButton';
import { PrimaryButton } from '../PrimaryButton';
import { ConsentSheet } from '../consent/ConsentSheet';
import { useHealthConnect } from '../../features/health-connect/useHealthConnect';
import type { UnitDistanceSnapshot } from '../../db/types';

type Props = {
  userId: string | null;
  unitDistance: UnitDistanceSnapshot;
  onRequestHealthConsent: () => Promise<{ ok: boolean }>;
};

/**
 * Profile › "Apps & devices" — the Health Connect connect surface (CORE-03).
 * Reuses the existing E1 health `ConsentSheet` verbatim (priming precedes
 * the OS/Health Connect permission grant, P0 §E rule 5) — this component
 * does not invent new consent copy.
 */
export function HealthConnectSection({ userId, unitDistance, onRequestHealthConsent }: Props) {
  const { state, syncing, platformGate, connect, syncNow, setWriteBackEnabled } = useHealthConnect(userId, unitDistance);
  const [consentSheetOpen, setConsentSheetOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  if (platformGate === 'ios_unsupported') {
    return (
      <SectionCard title="Apps & devices">
        <Text style={[theme.type.caption, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={2}>
          Health Connect is Android-only. Apple Health support is coming.
        </Text>
      </SectionCard>
    );
  }

  const handleConnectTap = () => setConsentSheetOpen(true);

  const handleAllowConsent = async () => {
    setConnecting(true);
    setConnectError(null);
    const consentResult = await onRequestHealthConsent();
    if (!consentResult.ok) {
      setConnecting(false);
      setConsentSheetOpen(false);
      setConnectError("Couldn't record consent — try again.");
      return;
    }
    const result = await connect();
    setConnecting(false);
    setConsentSheetOpen(false);
    if (!result.ok) {
      setConnectError(
        result.reason === 'unavailable'
          ? 'Health Connect is not installed on this device.'
          : result.reason === 'update_required'
            ? 'Health Connect needs an update from the Play Store.'
            : result.reason === 'permission_denied'
              ? 'Permission was not granted.'
              : 'Health Connect is Android-only.'
      );
      return;
    }
    void syncNow();
  };

  const chip = state.lastSyncError
    ? { label: 'Sync issue', fg: theme.color.feedback.warning, bg: theme.color.feedback.warningTint }
    : syncing
      ? { label: 'Syncing…', fg: theme.color.accent.data, bg: theme.color.accent.dataTint }
      : state.connected
        ? { label: 'Connected', fg: theme.color.feedback.success, bg: theme.color.feedback.successTint }
        : { label: 'Not connected', fg: theme.color.text.secondary, bg: theme.color.bg.inset };

  return (
    <SectionCard title="Apps & devices">
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={[theme.type.body, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>Health Connect</Text>
          {state.connected && !state.lastSyncError && (
            <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              {state.lastSyncedAt ? `Last synced · ${new Date(state.lastSyncedAt).toLocaleTimeString()}` : 'Not yet synced'}
            </Text>
          )}
          {state.lastSyncError && (
            <Text style={[theme.type.caption, { color: theme.color.feedback.warning }]} maxFontSizeMultiplier={2}>{state.lastSyncError}</Text>
          )}
          {connectError && <Text style={[theme.type.caption, { color: theme.color.feedback.warning }]} maxFontSizeMultiplier={2}>{connectError}</Text>}
        </View>
        <View style={styles.chip} accessibilityLabel={`Health Connect status: ${chip.label}`}>
          <View style={[styles.chipInner, { backgroundColor: chip.bg }]}>
            <Text style={[theme.type.caption, { color: chip.fg }]} maxFontSizeMultiplier={2}>{chip.label}</Text>
          </View>
        </View>
      </View>

      {!state.connected ? (
        <PrimaryButton label="Connect Health Connect" onPress={handleConnectTap} loading={connecting} />
      ) : state.lastSyncError ? (
        <TextButton label="Try again" onPress={() => void syncNow()} />
      ) : (
        <TextButton label="Sync now" onPress={() => void syncNow()} />
      )}

      {state.connected && (
        <View style={styles.writeBackRow}>
          <View style={styles.rowText}>
            <Text style={[theme.type.body, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>Also write my MileLift activities to Health Connect</Text>
            <Text style={[theme.type.caption, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={2}>
              Sends the session, distance, and calories — not your route. Your map stays in MileLift.
            </Text>
          </View>
          <TextButton
            label={state.writeBackEnabled ? 'Turn off' : 'Turn on'}
            onPress={() => void setWriteBackEnabled(!state.writeBackEnabled)}
          />
        </View>
      )}

      <ConsentSheet
        visible={consentSheetOpen}
        category="health"
        loading={connecting}
        onAllow={() => void handleAllowConsent()}
        onDecline={() => setConsentSheetOpen(false)}
      />
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: theme.space.sm,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  chip: {
    alignItems: 'flex-end',
  },
  chipInner: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xxs,
  },
  writeBackRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.space.sm,
    borderTopWidth: theme.border.hairline,
    borderTopColor: theme.color.border.subtle,
    paddingTop: theme.space.sm,
  },
});
