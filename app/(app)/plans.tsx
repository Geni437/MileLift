import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { EmptyState } from '../../src/components/EmptyState';
import { TextButton } from '../../src/components/TextButton';
import { SyncStatusPill } from '../../src/components/SyncStatusPill';
import { LiftStack, type LiftStackSegment } from '../../src/components/strength/LiftStack';
import { workoutTemplatesRepository } from '../../src/db/repositories/workoutTemplatesRepository';
import { programsRepository } from '../../src/db/repositories/programsRepository';
import { generateUuidV4 } from '../../src/lib/uuid';
import { runSync } from '../../src/sync/syncEngine';
import { useAuth } from '../../src/state/AuthContext';
import type { LocalProgram, LocalWorkoutTemplate } from '../../src/db/types';

type Segment = 'templates' | 'programs';

/** CORE-14 Plans landing: segmented Templates | Programs. Builder + starting a workout from a template — not a scheduling engine (§11). */
export default function PlansScreen() {
  const [segment, setSegment] = useState<Segment>('templates');
  const { userId } = useAuth();
  const [templates, setTemplates] = useState<LocalWorkoutTemplate[]>([]);
  const [programs, setPrograms] = useState<LocalProgram[]>([]);
  const [templateSummaries, setTemplateSummaries] = useState<Map<string, { count: number; segments: LiftStackSegment[] }>>(new Map());
  const [programTemplateCounts, setProgramTemplateCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const [t, p] = await Promise.all([workoutTemplatesRepository.listForUser(userId), programsRepository.listForUser(userId)]);
    setTemplates(t);
    setPrograms(p);
    setLoading(false);

    const [summaries, templateCounts] = await Promise.all([
      workoutTemplatesRepository.getExerciseSummariesForTemplates(t.map((x) => x.id)),
      programsRepository.getTemplateCountsForPrograms(p.map((x) => x.id)),
    ]);
    setTemplateSummaries(
      new Map(Array.from(summaries, ([id, s]) => [id, { count: s.count, segments: s.segments.map((seg) => ({ key: seg.id, volume: seg.volume, isPr: false })) }]))
    );
    setProgramTemplateCounts(templateCounts);
  }, [userId]);

  useEffect(() => {
    // Synchronizes local list/detail state with the local SQLite store on
    // mount / id change — same legitimate pattern as ProfileContext's own effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const createTemplate = async () => {
    if (!userId) return;
    const id = generateUuidV4();
    await workoutTemplatesRepository.create(id, userId, 'New template', null);
    void runSync('post-write');
    router.push({ pathname: '/plans/template/[id]', params: { id } });
  };

  const createProgram = async () => {
    if (!userId) return;
    const id = generateUuidV4();
    await programsRepository.create(id, userId, 'New program', null, null);
    void runSync('post-write');
    router.push({ pathname: '/plans/program/[id]', params: { id } });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Plans
          </Text>
          <TextButton label="Close" onPress={() => router.back()} />
        </View>
        <SegmentedControl
          options={[
            { label: 'Templates', value: 'templates' },
            { label: 'Programs', value: 'programs' },
          ]}
          value={segment}
          onChange={setSegment}
        />
      </View>

      {loading ? null : segment === 'templates' ? (
        <FlatList
          data={templates}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={<TextButton label="＋ New template" onPress={() => void createTemplate()} />}
          ListEmptyComponent={
            <EmptyState title="Build a template once, start it in two taps forever after." actionLabel="＋ New template" onAction={() => void createTemplate()} />
          }
          renderItem={({ item }) => {
            const summary = templateSummaries.get(item.id);
            const exerciseCount = summary?.count ?? 0;
            return (
              <Pressable
                onPress={() => router.push({ pathname: '/plans/template/[id]', params: { id: item.id } })}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${exerciseCount} ${exerciseCount === 1 ? 'exercise' : 'exercises'}`}
                style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
              >
                <View style={styles.rowContent}>
                  <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                    {item.name}
                  </Text>
                  <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                    {exerciseCount} {exerciseCount === 1 ? 'exercise' : 'exercises'}
                  </Text>
                  {item.syncStatus !== 'synced' && <SyncStatusPill status={item.syncStatus} />}
                </View>
                <LiftStack variant="static" segments={summary?.segments ?? []} height={40} />
              </Pressable>
            );
          }}
        />
      ) : (
        <FlatList
          data={programs}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={<TextButton label="＋ New program" onPress={() => void createProgram()} />}
          ListEmptyComponent={
            <EmptyState title="A program strings your templates into a plan across the week." actionLabel="＋ New program" onAction={() => void createProgram()} />
          }
          renderItem={({ item }) => {
            const templateCount = programTemplateCounts.get(item.id) ?? 0;
            return (
              <Pressable
                onPress={() => router.push({ pathname: '/plans/program/[id]', params: { id: item.id } })}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${templateCount} ${templateCount === 1 ? 'template' : 'templates'}`}
                style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
              >
                <View style={styles.rowContent}>
                  <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                    {item.name}
                  </Text>
                  <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                    {item.lengthWeeks != null ? `${item.lengthWeeks} ${item.lengthWeeks === 1 ? 'week' : 'weeks'} · ` : ''}
                    {templateCount} {templateCount === 1 ? 'template' : 'templates'}
                  </Text>
                </View>
                {item.syncStatus !== 'synced' && <SyncStatusPill status={item.syncStatus} />}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md, gap: theme.space.md },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  listContent: { paddingHorizontal: theme.screen.edge, paddingBottom: theme.space.colossal, gap: theme.space.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm, minHeight: theme.touchTarget.comfortable, paddingVertical: theme.space.sm, borderBottomWidth: theme.border.hairline, borderBottomColor: theme.color.border.subtle },
  rowContent: { flex: 1, gap: 2 },
});
