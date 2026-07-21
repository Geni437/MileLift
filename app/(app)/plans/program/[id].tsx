import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../../src/theme';
import { Field } from '../../../../src/components/Field';
import { TextButton } from '../../../../src/components/TextButton';
import { InlineBanner } from '../../../../src/components/InlineBanner';
import { programsRepository } from '../../../../src/db/repositories/programsRepository';
import { workoutTemplatesRepository } from '../../../../src/db/repositories/workoutTemplatesRepository';
import { generateUuidV4 } from '../../../../src/lib/uuid';
import { runSync } from '../../../../src/sync/syncEngine';
import { useAuth } from '../../../../src/state/AuthContext';
import type { LocalProgramWorkout, LocalWorkoutTemplate } from '../../../../src/db/types';

/**
 * CORE-14 program builder — a schedule LIST, deliberately not a calendar
 * (§11: no scheduling engine exists yet — a calendar grid would imply
 * auto-advancing days that don't work). Associates templates to week/day slots.
 */
export default function ProgramBuilderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lengthWeeks, setLengthWeeks] = useState('');
  const [slots, setSlots] = useState<LocalProgramWorkout[]>([]);
  const [templates, setTemplates] = useState<LocalWorkoutTemplate[]>([]);
  const [showAddSlot, setShowAddSlot] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(async () => {
    if (!id || !userId) return;
    setLoading(true);
    const program = await programsRepository.getById(id);
    if (program) {
      setName(program.name);
      setDescription(program.description ?? '');
      setLengthWeeks(program.lengthWeeks != null ? String(program.lengthWeeks) : '');
    }
    const [workouts, allTemplates] = await Promise.all([programsRepository.listWorkouts(id), workoutTemplatesRepository.listForUser(userId)]);
    setSlots(workouts.sort((a, b) => a.sortOrder - b.sortOrder));
    setTemplates(allTemplates);
    setLoading(false);
  }, [id, userId]);

  useEffect(() => {
    // Synchronizes local list/detail state with the local SQLite store on
    // mount / id change — same legitimate pattern as ProfileContext's own effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSaveMeta = async () => {
    if (!id) return;
    const parsedWeeks = lengthWeeks.trim() ? Number(lengthWeeks) : null;
    await programsRepository.update(id, name.trim() || 'Program', description.trim() || null, parsedWeeks && parsedWeeks > 0 ? Math.round(parsedWeeks) : null);
    void runSync('post-write');
  };

  const handleAddSlot = async (template: LocalWorkoutTemplate, week: number | null, day: number | null) => {
    if (!id || !userId) return;
    const sortOrder = slots.length === 0 ? 0 : Math.max(...slots.map((s) => s.sortOrder)) + 1;
    await programsRepository.upsertWorkout(generateUuidV4(), id, userId, { templateId: template.id, templateNameLocal: template.name, weekNumber: week, dayNumber: day, sortOrder });
    void runSync('post-write');
    setShowAddSlot(false);
    await load();
  };

  const handleRemoveSlot = async (slotId: string) => {
    await programsRepository.removeWorkout(slotId);
    void runSync('post-write');
    await load();
  };

  if (loading) return <SafeAreaView style={styles.safe} />;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TextButton label="Back" onPress={() => router.back()} />
        </View>

        <Field label="Name" value={name} onChangeText={setName} onBlur={() => void handleSaveMeta()} />
        <Field label="Description (optional)" value={description} onChangeText={setDescription} onBlur={() => void handleSaveMeta()} />
        <Field label="Length (weeks, optional)" value={lengthWeeks} onChangeText={setLengthWeeks} onBlur={() => void handleSaveMeta()} keyboardType="number-pad" />

        <InlineBanner tone="info" message="Programs organize your templates. Scheduling and auto-progression are coming — for now, start any day's workout yourself." />

        <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
          Schedule
        </Text>
        {slots.length === 0 ? (
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            Add a slot to tie a template to a week/day.
          </Text>
        ) : (
          slots.map((slot) => (
            <View key={slot.id} style={[styles.slotRow, { borderColor: theme.color.border.subtle }]}>
              <View>
                <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                  {slot.weekNumber != null ? `Week ${slot.weekNumber} · ` : ''}
                  {slot.dayNumber != null ? `Day ${slot.dayNumber} — ` : ''}
                  {slot.templateNameLocal}
                </Text>
              </View>
              <TextButton label="Remove" danger onPress={() => void handleRemoveSlot(slot.id)} />
            </View>
          ))
        )}
        <TextButton label="＋ Add slot" disabled={templates.length === 0} onPress={() => setShowAddSlot(true)} />
        {templates.length === 0 && (
          // text.tertiary never clears AA at normal caption size (tokens.md "Contrast") — text.secondary.
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            Create a template first (Plans › Templates).
          </Text>
        )}
      </ScrollView>

      <AddSlotSheet visible={showAddSlot} templates={templates} onClose={() => setShowAddSlot(false)} onAdd={handleAddSlot} />
    </SafeAreaView>
  );
}

function AddSlotSheet({
  visible,
  templates,
  onClose,
  onAdd,
}: {
  visible: boolean;
  templates: LocalWorkoutTemplate[];
  onClose: () => void;
  onAdd: (template: LocalWorkoutTemplate, week: number | null, day: number | null) => void;
}) {
  const [week, setWeek] = useState('');
  const [day, setDay] = useState('');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}>
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              Add a slot
            </Text>
            <Field label="Week (optional)" value={week} onChangeText={setWeek} keyboardType="number-pad" />
            <Field label="Day (optional)" value={day} onChangeText={setDay} keyboardType="number-pad" />
            <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              Choose a template
            </Text>
            {/* A plain selectable row list, not one ember PrimaryButton per
                template — tokens.md: "ember is spent, not sprinkled ... if
                two things on a screen are ember, one of them is wrong."
                Mirrors WorkoutRow/lift.tsx's own SheetOption row pattern. */}
            {templates.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => onAdd(t, week.trim() ? Number(week) : null, day.trim() ? Number(day) : null)}
                accessibilityRole="button"
                accessibilityLabel={t.name}
                style={({ pressed }) => [styles.templateOption, { borderColor: theme.color.border.subtle }, pressed && { opacity: theme.opacity.pressed }]}
              >
                <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                  {t.name}
                </Text>
              </Pressable>
            ))}
            <TextButton label="Cancel" onPress={onClose} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.md },
  headerRow: { flexDirection: 'row' },
  slotRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: theme.border.hairline, borderRadius: theme.radius.md, padding: theme.space.sm },
  templateOption: { minHeight: theme.touchTarget.comfortable, justifyContent: 'center', paddingHorizontal: theme.space.sm, borderWidth: theme.border.hairline, borderRadius: theme.radius.md },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.sm, maxHeight: '80%' },
});
