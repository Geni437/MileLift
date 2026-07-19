import React, { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { EmptyState } from '../../../src/components/EmptyState';
import { MeridianMark } from '../../../src/components/MeridianMark';
import { ActivityRow } from '../../../src/components/activity/ActivityRow';
import { WeekHeader } from '../../../src/components/activity/WeekHeader';
import { RecordRow } from '../../../src/components/activity/RecordRow';
import { useActivityLog, type WeekGroup } from '../../../src/features/activity/useActivityLog';
import { usePersonalRecords } from '../../../src/features/activity/usePersonalRecords';
import { useAuth } from '../../../src/state/AuthContext';
import { useProfile } from '../../../src/state/ProfileContext';

type Segment = 'log' | 'records';

/** Activity tab: segmented Log | Records header (CORE-02/04/05). */
export default function ActivityScreen() {
  const [segment, setSegment] = useState<Segment>('log');
  const { userId } = useAuth();
  const { profile } = useProfile();
  const unit = profile?.unitDistance ?? 'km';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>Activity</Text>
        <SegmentedControl
          options={[
            { label: 'Log', value: 'log' },
            { label: 'Records', value: 'records' },
          ]}
          value={segment}
          onChange={setSegment}
        />
      </View>

      {segment === 'log' ? <LogSegment userId={userId} unit={unit} /> : <RecordsSegment userId={userId} unit={unit} />}

      <Pressable
        onPress={() => router.push('/record')}
        accessibilityRole="button"
        accessibilityLabel="Start recording"
        style={({ pressed }) => [styles.fab, { backgroundColor: theme.color.accent.primary }, pressed && { opacity: theme.opacity.pressed }]}
      >
        <MeridianMark variant="glyph" size={28} />
      </Pressable>
    </SafeAreaView>
  );
}

function LogSegment({ userId, unit }: { userId: string | null; unit: 'km' | 'mi' }) {
  const { loadState, loadError, weeks, activityTypes, prByActivityId, hasMore, loadingMore, refreshing, loadMore, refresh, retrySync } =
    useActivityLog(userId);

  if (loadState === 'loading') {
    return (
      <View style={styles.listContent}>
        <SkeletonBlock height={24} width={140} />
        <SkeletonBlock height={90} radius={theme.radius.lg} />
        <SkeletonBlock height={90} radius={theme.radius.lg} />
        <SkeletonBlock height={90} radius={theme.radius.lg} />
      </View>
    );
  }

  if (loadState === 'error') {
    return (
      <View style={styles.listContent}>
        <InlineBanner
          tone="warning"
          message={
            loadError
              ? `Couldn't load your history — ${loadError} Anything saved on this device is still here.`
              : "Couldn't load your history — you may be offline. Anything saved on this device is still here."
          }
          actionLabel="Retry"
          onAction={() => void refresh()}
        />
      </View>
    );
  }

  if (loadState === 'empty') {
    return (
      <View style={styles.listContent}>
        <EmptyState
          title="Your log starts with one mile."
          body="Record a run, ride, walk, or hike and it lands here — every one adds to a single training history."
          actionLabel="Start recording"
          onAction={() => router.push('/record')}
        />
      </View>
    );
  }

  return (
    <FlatList<WeekGroup>
      data={weeks}
      keyExtractor={(w) => w.weekKey}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.color.accent.primary} />}
      onEndReachedThreshold={0.4}
      onEndReached={() => void loadMore()}
      renderItem={({ item: week }) => (
        <View style={styles.weekBlock}>
          <WeekHeader weekKey={week.weekKey} totalDistanceM={week.totalDistanceM} activityCount={week.activityCount} unit={unit} />
          {week.activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              activityType={activityTypes.get(activity.activityTypeCode) ?? null}
              hasPr={prByActivityId.has(activity.id)}
              onPress={() => router.push({ pathname: '/activity/[id]', params: { id: activity.id } })}
              onRetrySync={activity.syncStatus === 'failed' ? retrySync : undefined}
            />
          ))}
        </View>
      )}
      ListFooterComponent={
        loadingMore ? (
          <SkeletonBlock height={60} radius={theme.radius.lg} />
        ) : !hasMore ? (
          <Text style={[theme.type.caption, styles.endOfList, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={2}>
            That&apos;s the start of your history.
          </Text>
        ) : null
      }
    />
  );
}

function RecordsSegment({ userId, unit }: { userId: string | null; unit: 'km' | 'mi' }) {
  const { loadState, groups, refreshing, refresh } = usePersonalRecords(userId);

  if (loadState === 'loading') {
    return (
      <View style={styles.listContent}>
        <SkeletonBlock height={24} width={100} />
        <SkeletonBlock height={80} radius={theme.radius.lg} />
        <SkeletonBlock height={80} radius={theme.radius.lg} />
      </View>
    );
  }

  if (loadState === 'error') {
    return (
      <View style={styles.listContent}>
        <InlineBanner tone="warning" message="Couldn't load your records — you may be offline." actionLabel="Retry" onAction={() => void refresh()} />
      </View>
    );
  }

  if (loadState === 'empty') {
    return (
      <View style={styles.listContent}>
        <EmptyState title="Records show up as you log." body="Your first activity of any type sets the bar." />
      </View>
    );
  }

  return (
    <FlatList
      data={groups}
      keyExtractor={(g) => g.activityType.code}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.color.accent.primary} />}
      renderItem={({ item: group }) => (
        <View style={styles.recordGroup}>
          <View style={styles.recordGroupHeader}>
            <MeridianMark variant="glyph" size={20} />
            <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>{group.activityType.displayName}</Text>
          </View>
          {group.records.map((record) => (
            <RecordRow
              key={record.metric}
              record={record}
              unit={unit}
              onPress={() => router.push({ pathname: '/activity/[id]', params: { id: record.timelineEventId } })}
            />
          ))}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.color.bg.canvas,
  },
  header: {
    paddingHorizontal: theme.screen.edge,
    paddingTop: theme.space.md,
    gap: theme.space.md,
  },
  listContent: {
    paddingHorizontal: theme.screen.edge,
    paddingBottom: theme.space.colossal,
    gap: theme.space.sm,
  },
  weekBlock: {
    gap: theme.space.xs,
  },
  recordGroup: {
    gap: theme.space.xxs,
    marginBottom: theme.space.lg,
  },
  recordGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    marginBottom: theme.space.xs,
  },
  endOfList: {
    textAlign: 'center',
    paddingVertical: theme.space.lg,
  },
  fab: {
    position: 'absolute',
    right: theme.space.lg,
    bottom: theme.space.lg,
    width: theme.touchTarget.comfortable + 12, // 64pt spec ("carrying the Meridian origin glyph as its mark")
    height: theme.touchTarget.comfortable + 12,
    borderRadius: (theme.touchTarget.comfortable + 12) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.elevation.md,
  },
});
