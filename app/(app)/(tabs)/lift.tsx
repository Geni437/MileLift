import React, { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { EmptyState } from '../../../src/components/EmptyState';
import { MeridianMark } from '../../../src/components/MeridianMark';
import { TextButton } from '../../../src/components/TextButton';
import { WorkoutRow } from '../../../src/components/strength/WorkoutRow';
import { StrengthRecordRow } from '../../../src/components/strength/StrengthRecordRow';
import { useWorkoutLog, type WorkoutWeekGroup } from '../../../src/features/strength/useWorkoutLog';
import { useStrengthRecordsList } from '../../../src/features/strength/useStrengthRecordsList';
import { workoutTemplatesRepository } from '../../../src/db/repositories/workoutTemplatesRepository';
import { workoutSessionsRepository } from '../../../src/db/repositories/workoutSessionsRepository';
import { useAuth } from '../../../src/state/AuthContext';
import { useProfile } from '../../../src/state/ProfileContext';
import { formatVolumeValue, formatWeekLabel } from '../../../src/lib/format';
import type { LocalWorkoutTemplate, LocalWorkoutSession } from '../../../src/db/types';

type Segment = 'log' | 'records';

/** Lift tab (design doc §B): segmented Log | Records, an entry row (Plans · Body · Exercises), and the Start-a-workout FAB. */
export default function LiftScreen() {
  const [segment, setSegment] = useState<Segment>('log');
  const [showStartSheet, setShowStartSheet] = useState(false);
  const { userId } = useAuth();
  const { profile } = useProfile();
  const unitWeight = profile?.unitWeight ?? 'kg';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          Lift
        </Text>
        <SegmentedControl
          options={[
            { label: 'Log', value: 'log' },
            { label: 'Records', value: 'records' },
          ]}
          value={segment}
          onChange={setSegment}
        />
        <View style={styles.entryRow}>
          <TextButton label="Plans" onPress={() => router.push('/plans')} />
          <TextButton label="Body" onPress={() => router.push('/body')} />
          <TextButton label="Exercises" onPress={() => router.push('/exercises')} />
        </View>
      </View>

      {segment === 'log' ? <LogSegment userId={userId} unitWeight={unitWeight} /> : <RecordsSegment userId={userId} unitWeight={unitWeight} />}

      <Pressable
        onPress={() => setShowStartSheet(true)}
        accessibilityRole="button"
        accessibilityLabel="Start a workout"
        style={({ pressed }) => [styles.fab, { backgroundColor: theme.color.accent.primary }, pressed && { opacity: theme.opacity.pressed }]}
      >
        <MeridianMark variant="glyph" size={28} />
      </Pressable>

      <StartWorkoutSheet visible={showStartSheet} userId={userId} onClose={() => setShowStartSheet(false)} />
    </SafeAreaView>
  );
}

function LogSegment({ userId, unitWeight }: { userId: string | null; unitWeight: 'kg' | 'lb' }) {
  const { loadState, loadError, weeks, prBySessionId, hasMore, loadingMore, refreshing, loadMore, refresh, retrySync } = useWorkoutLog(userId);

  if (loadState === 'loading') {
    return (
      <View style={styles.listContent}>
        <SkeletonBlock height={24} width={140} />
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
          title="Your first set starts the log."
          body="Log a workout and it lands here — every session adds to one training history."
          actionLabel="Start a workout"
          onAction={() => router.push('/workout')}
        />
      </View>
    );
  }

  return (
    <FlatList<WorkoutWeekGroup>
      data={weeks}
      keyExtractor={(w) => w.weekKey}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.color.accent.primary} />}
      onEndReachedThreshold={0.4}
      onEndReached={() => void loadMore()}
      renderItem={({ item: week }) => (
        <View style={styles.weekBlock}>
          <View style={styles.weekHeader}>
            <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
              {formatWeekLabel(week.weekKey)}
            </Text>
            <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              {formatVolumeValue(week.totalVolumeKg, unitWeight)} {unitWeight} · {week.sessionCount} {week.sessionCount === 1 ? 'session' : 'sessions'}
            </Text>
          </View>
          {week.sessions.map((session: LocalWorkoutSession) => (
            <WorkoutRow
              key={session.id}
              session={session}
              unitWeight={unitWeight}
              segments={[]}
              hasPr={prBySessionId.has(session.id)}
              onPress={() => router.push({ pathname: '/workout/[id]', params: { id: session.id } })}
              onRetrySync={session.syncStatus === 'failed' ? retrySync : undefined}
            />
          ))}
        </View>
      )}
      ListFooterComponent={
        loadingMore ? (
          <SkeletonBlock height={60} radius={theme.radius.lg} />
        ) : !hasMore ? (
          <Text style={[theme.type.caption, styles.endOfList, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            That&apos;s the start of your training log.
          </Text>
        ) : null
      }
    />
  );
}

function RecordsSegment({ userId, unitWeight }: { userId: string | null; unitWeight: 'kg' | 'lb' }) {
  const { loadState, groups, refreshing, refresh } = useStrengthRecordsList(userId);

  if (loadState === 'loading') {
    return (
      <View style={styles.listContent}>
        <SkeletonBlock height={24} width={100} />
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
        <EmptyState title="Records show up as you lift." body="Your first working set of any movement sets the bar." />
      </View>
    );
  }

  return (
    <FlatList
      data={groups}
      keyExtractor={(g) => g.exerciseRef}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.color.accent.primary} />}
      renderItem={({ item: group }) => (
        <View style={styles.recordGroup}>
          <View style={styles.recordGroupHeader}>
            <MeridianMark variant="glyph" size={20} />
            <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
              {group.exerciseName}
            </Text>
          </View>
          {group.records.map((record) => (
            <StrengthRecordRow
              key={record.metric}
              record={record}
              unitWeight={unitWeight}
              onPress={() => router.push({ pathname: '/workout/[id]', params: { id: record.timelineEventId } })}
            />
          ))}
        </View>
      )}
    />
  );
}

function StartWorkoutSheet({ visible, userId, onClose }: { visible: boolean; userId: string | null; onClose: () => void }) {
  const [templates, setTemplates] = useState<LocalWorkoutTemplate[]>([]);
  const [resumeSession, setResumeSession] = useState<LocalWorkoutSession | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    // Synchronizes this sheet's local list state with the local SQLite store
    // whenever it opens — the same legitimate "sync with an external system"
    // pattern documented in ProfileContext/ConsentContext (not a React-
    // Compiler hazard; this project doesn't use the compiler).
    if (!visible || !userId) return;
    void workoutTemplatesRepository.listForUser(userId).then(setTemplates);
    void workoutSessionsRepository.getInProgressForUser(userId).then(setResumeSession);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowTemplates(false);
  }, [visible, userId]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            {!showTemplates ? (
              <>
                <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                  Start a workout
                </Text>
                {resumeSession && (
                  <SheetOption
                    label="Resume"
                    hint="You have a workout in progress"
                    onPress={() => {
                      onClose();
                      router.push('/workout');
                    }}
                  />
                )}
                <SheetOption
                  label="Empty workout"
                  onPress={() => {
                    onClose();
                    router.push('/workout');
                  }}
                />
                <SheetOption label="From a template" hint={templates.length === 0 ? 'No templates yet' : undefined} disabled={templates.length === 0} onPress={() => setShowTemplates(true)} />
                <TextButton label="Cancel" onPress={onClose} />
              </>
            ) : (
              <>
                <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                  Choose a template
                </Text>
                {templates.map((t) => (
                  <SheetOption
                    key={t.id}
                    label={t.name}
                    onPress={() => {
                      onClose();
                      router.push({ pathname: '/workout', params: { templateId: t.id } });
                    }}
                  />
                ))}
                <TextButton label="Back" onPress={() => setShowTemplates(false)} />
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function SheetOption({ label, hint, disabled, onPress }: { label: string; hint?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.sheetOption, { borderColor: theme.color.border.subtle }, pressed && !disabled && { opacity: theme.opacity.pressed }]}
    >
      <Text style={[theme.type.bodyStrong, { color: disabled ? theme.color.text.disabled : theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
        {label}
      </Text>
      {hint && (
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {hint}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md, gap: theme.space.md },
  entryRow: { flexDirection: 'row', gap: theme.space.md },
  listContent: { paddingHorizontal: theme.screen.edge, paddingBottom: theme.space.colossal, gap: theme.space.sm },
  weekBlock: { gap: theme.space.xs },
  weekHeader: { gap: theme.space.xxs, paddingTop: theme.space.md },
  recordGroup: { gap: theme.space.xxs, marginBottom: theme.space.lg },
  recordGroupHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, marginBottom: theme.space.xs },
  endOfList: { textAlign: 'center', paddingVertical: theme.space.lg },
  fab: {
    position: 'absolute',
    right: theme.space.lg,
    bottom: theme.space.lg,
    width: theme.touchTarget.comfortable + 12,
    height: theme.touchTarget.comfortable + 12,
    borderRadius: (theme.touchTarget.comfortable + 12) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.elevation.md,
  },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.sm },
  sheetOption: { minHeight: theme.touchTarget.comfortable, justifyContent: 'center', paddingVertical: theme.space.sm, borderBottomWidth: theme.border.hairline },
});
