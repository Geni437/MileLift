import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { EmptyState } from '../../src/components/EmptyState';
import { TextButton } from '../../src/components/TextButton';
import { SyncStatusPill } from '../../src/components/SyncStatusPill';
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
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const [t, p] = await Promise.all([workoutTemplatesRepository.listForUser(userId), programsRepository.listForUser(userId)]);
    setTemplates(t);
    setPrograms(p);
    setLoading(false);
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
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/plans/template/[id]', params: { id: item.id } })}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
            >
              <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                {item.name}
              </Text>
              {item.syncStatus !== 'synced' && <SyncStatusPill status={item.syncStatus} />}
            </Pressable>
          )}
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
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/plans/program/[id]', params: { id: item.id } })}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
            >
              <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                {item.name}
              </Text>
              {item.syncStatus !== 'synced' && <SyncStatusPill status={item.syncStatus} />}
            </Pressable>
          )}
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
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: theme.touchTarget.comfortable, paddingVertical: theme.space.sm, borderBottomWidth: theme.border.hairline, borderBottomColor: theme.color.border.subtle },
});
