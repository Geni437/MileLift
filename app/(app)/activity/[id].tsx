import React, { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { Screen } from '../../../src/components/Screen';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { EmptyState } from '../../../src/components/EmptyState';
import { TextButton } from '../../../src/components/TextButton';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { SecondaryButton } from '../../../src/components/SecondaryButton';
import { Field } from '../../../src/components/Field';
import { SyncStatusPill } from '../../../src/components/SyncStatusPill';
import { MeridianMark } from '../../../src/components/MeridianMark';
import { MetricBar, type MetricBarItem } from '../../../src/components/activity/MetricBar';
import { MeridianTrace } from '../../../src/components/activity/MeridianTrace';
import { RouteMap } from '../../../src/components/activity/RouteMap';
import { formatDistanceValue, formatDuration, formatElevation, formatHeartRate, formatPace, formatRelativeDateTime } from '../../../src/lib/format';
import { formatPrHeadline, formatPrValue } from '../../../src/features/activity/prDisplay';
import { useActivityDetail } from '../../../src/features/activity/useActivityDetail';
import { useNetworkStatus } from '../../../src/hooks/useNetworkStatus';
import { normalizeSeries } from '../../../src/lib/geo';

export default function ActivityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isOnline } = useNetworkStatus();
  const { loadState, activity, activityType, routePoints, bounds, achievements, kudosCount, deleteActivity, editActivity } =
    useActivityDetail(id);
  const [editOpen, setEditOpen] = useState(false);

  if (loadState === 'loading') {
    return (
      <Screen>
        <SkeletonBlock height={220} radius={theme.radius.lg} />
        <SkeletonBlock height={28} width={200} />
        <SkeletonBlock height={90} radius={theme.radius.lg} />
      </Screen>
    );
  }

  if (loadState === 'not_found') {
    return (
      <Screen>
        <EmptyState title="This activity isn't here anymore." actionLabel="Back" onAction={() => router.back()} />
      </Screen>
    );
  }

  if (loadState === 'error' || !activity) {
    return (
      <Screen>
        <EmptyState title="Couldn't load this activity." body="You may be offline. Try again shortly." actionLabel="Back" onAction={() => router.back()} />
      </Screen>
    );
  }

  const isDistanceBased = activityType?.isDistanceBased ?? activity.distanceM != null;
  const tracksElevation = activityType?.tracksElevation ?? activity.elevationGainM != null;
  const metricItems: MetricBarItem[] = isDistanceBased
    ? [
        { key: 'distance', value: formatDistanceValue(activity.distanceM, activity.unitDistanceSnapshot), unit: activity.unitDistanceSnapshot, label: 'Distance' },
        { key: 'moving', value: formatDuration(activity.movingTimeSeconds ?? activity.durationSeconds), label: 'Moving time' },
        { key: 'pace', value: formatPace(activity.averageSpeedMps, activity.unitDistanceSnapshot), label: 'Avg pace' },
        ...(tracksElevation ? [{ key: 'elevation', value: formatElevation(activity.elevationGainM), unit: 'm', label: 'Elevation gain' }] : []),
      ]
    : [{ key: 'duration', value: formatDuration(activity.durationSeconds), label: 'Duration' }];

  const handleDelete = () => {
    Alert.alert('Delete this activity?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void deleteActivity().then(() => router.back());
        },
      },
    ]);
  };

  return (
    <Screen>
      {activity.hasGpsRoute ? (
        <RouteMap isOwnActivity points={routePoints} bounds={bounds} height={220} tilesUnavailable={!isOnline} />
      ) : (
        <View style={[styles.manualHeader, { backgroundColor: theme.color.bg.raised }]}>
          <MeridianMark variant="seed" size={40} />
          <Text style={[theme.type.overline, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.8}>
            MANUAL ENTRY
          </Text>
        </View>
      )}

      <View style={styles.titleBlock}>
        <View style={styles.titleRow}>
          <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6} numberOfLines={2}>{activity.title ?? activity.activityTypeNameSnapshot}</Text>
          {activity.syncStatus !== 'synced' && <SyncStatusPill status={activity.syncStatus} />}
        </View>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          {activity.activityTypeNameSnapshot} · {formatRelativeDateTime(activity.occurredAt)}
        </Text>
      </View>

      <MetricBar items={metricItems} />

      {activity.hasGpsRoute && (
        <MeridianTrace variant="static" height={80} series={normalizeSeries(routePoints.map((p) => p.elevationM ?? 0))} />
      )}

      {(activity.averageHr != null || activity.maxHr != null) && (
        <MetricBar
          items={[
            { key: 'avgHr', value: formatHeartRate(activity.averageHr), unit: 'bpm', label: 'Avg HR' },
            { key: 'maxHr', value: formatHeartRate(activity.maxHr), unit: 'bpm', label: 'Max HR' },
          ]}
          size="inline"
        />
      )}

      {achievements.length > 0 && (
        <View style={styles.achievements}>
          <Text style={[theme.type.overline, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.8}>
            ACHIEVEMENTS
          </Text>
          {achievements.map((a) => (
            <Text key={a.id} style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
              {formatPrHeadline(activity.activityTypeNameSnapshot, a.metric, a.rank === 'pr')} · {formatPrValue(a.metric, a.value, activity.unitDistanceSnapshot)}
            </Text>
          ))}
        </View>
      )}

      {/* Kudos — reserved, non-interactive spot (design doc CORE-02 point 8). No Phase 1 cross-user interaction to wire yet. */}
      <View style={styles.kudosRow} accessibilityLabel={`${kudosCount} kudos`}>
        <MeridianMark variant="glyph" size={20} />
        <Text style={[theme.type.body, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={2}>{kudosCount} Kudos</Text>
      </View>

      <View style={styles.actions}>
        <TextButton label="Edit" onPress={() => setEditOpen(true)} />
        <TextButton label="Delete" danger onPress={handleDelete} />
      </View>

      <EditSheet
        visible={editOpen}
        initialTitle={activity.title ?? ''}
        initialDescription={activity.description ?? ''}
        onCancel={() => setEditOpen(false)}
        onSave={async (title, description) => {
          await editActivity({ title: title || null, description: description || null });
          setEditOpen(false);
        }}
      />
    </Screen>
  );
}

function EditSheet({
  visible,
  initialTitle,
  initialDescription,
  onCancel,
  onSave,
}: {
  visible: boolean;
  initialTitle: string;
  initialDescription: string;
  onCancel: () => void;
  onSave: (title: string, description: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Dismiss" accessibilityRole="button" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>Edit activity</Text>
            <Field label="Title" value={title} onChangeText={setTitle} maxLength={120} />
            <Field label="Description" value={description} onChangeText={setDescription} maxLength={500} multiline />
            <View style={styles.editActions}>
              <PrimaryButton
                label="Save"
                loading={saving}
                onPress={async () => {
                  setSaving(true);
                  await onSave(title.trim(), description.trim());
                  setSaving(false);
                }}
              />
              <SecondaryButton label="Cancel" onPress={onCancel} disabled={saving} />
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  manualHeader: {
    height: 100,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
  },
  titleBlock: {
    gap: theme.space.xxs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  achievements: {
    gap: theme.space.xxs,
  },
  kudosRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    minHeight: theme.touchTarget.min,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.space.md,
  },
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    width: '100%',
  },
  sheet: {
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  editActions: {
    gap: theme.space.sm,
  },
});
