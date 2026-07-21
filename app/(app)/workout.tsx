import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';

import { theme } from '../../src/theme';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { SecondaryButton } from '../../src/components/SecondaryButton';
import { TextButton } from '../../src/components/TextButton';
import { Field } from '../../src/components/Field';
import { ConfirmSheet } from '../../src/components/ConfirmSheet';
import { SyncStatusPill } from '../../src/components/SyncStatusPill';
import { MeridianMark } from '../../src/components/MeridianMark';
import { ExerciseBlock } from '../../src/components/strength/ExerciseBlock';
import { LiftStack, type LiftStackSegment } from '../../src/components/strength/LiftStack';
import { RestTimer } from '../../src/components/strength/RestTimer';
import { StrengthPrCallout } from '../../src/components/strength/StrengthPrCallout';
import { formatDuration, formatVolumeValue } from '../../src/lib/format';
import { exercisesRepository, exerciseFieldFlags } from '../../src/db/repositories/exercisesRepository';
import { customExercisesRepository } from '../../src/db/repositories/customExercisesRepository';
import { workoutTemplatesRepository } from '../../src/db/repositories/workoutTemplatesRepository';
import { openExercisePicker } from '../../src/lib/exercisePickerBridge';
import { useWorkoutEngine, type ExercisePick, type FinishDraft } from '../../src/features/strength/useWorkoutEngine';
import { useAuth } from '../../src/state/AuthContext';
import { useProfile } from '../../src/state/ProfileContext';
import type { ExerciseFieldFlags, MuscleGroup } from '../../src/db/types';

async function resolvePick(exerciseId: string | null, customExerciseId: string | null, nameFallback: string): Promise<ExercisePick> {
  if (exerciseId) {
    const ex = await exercisesRepository.getById(exerciseId);
    if (ex) return { exerciseId, customExerciseId: null, name: ex.name, primaryMuscle: ex.primaryMuscle, fieldFlags: exerciseFieldFlags(ex) };
  } else if (customExerciseId) {
    const ex = await customExercisesRepository.getById(customExerciseId);
    if (ex) {
      return {
        exerciseId: null,
        customExerciseId,
        name: ex.name,
        primaryMuscle: ex.primaryMuscle,
        fieldFlags: { isWeighted: ex.isWeighted, isBodyweight: ex.isBodyweight, isTimeBased: ex.isTimeBased, isDistanceBased: ex.isDistanceBased },
      };
    }
  }
  // Fallback: the referenced exercise couldn't be resolved locally (e.g.
  // library not yet synced on a fresh install) — default to a weighted
  // rep-based movement rather than silently dropping it from the session.
  const fallbackFlags: ExerciseFieldFlags = { isWeighted: true, isBodyweight: false, isTimeBased: false, isDistanceBased: false };
  return { exerciseId, customExerciseId, name: nameFallback, primaryMuscle: null as MuscleGroup | null, fieldFlags: fallbackFlags };
}

/** CORE-12 — the active workout logging screen, the module's core surface. */
export default function WorkoutScreen() {
  const { templateId, prefillExerciseId, editSessionId } = useLocalSearchParams<{ templateId?: string; prefillExerciseId?: string; editSessionId?: string }>();
  const { userId } = useAuth();
  const { profile } = useProfile();
  const unitWeight = profile?.unitWeight ?? 'kg';
  const engine = useWorkoutEngine({ userId: userId ?? '', unitWeight });

  const [starting, setStarting] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showTitleEdit, setShowTitleEdit] = useState(false);
  const [finishDraft, setFinishDraft] = useState<FinishDraft | null>(null);

  // `new Date()` is an impure read — tying it to `engine.tick` (the hook's
  // own 1s countup) via useMemo is the same escape hatch useRecordingEngine's
  // screen already uses for its own live elapsed-time clock. Must be called
  // unconditionally (before any early return below), same as every other hook here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [engine.tick]);

  useEffect(() => {
    // Editing an already-finished session takes priority over crash-recovery
    // (the two are mutually exclusive in practice — a finished session is
    // never also the in-progress row — but editSessionId is this screen's
    // explicit intent regardless) and never runs the fresh-start branch below.
    if (engine.loading || engine.session) return;
    if (editSessionId) {
      void engine.loadForEdit(editSessionId);
      return;
    }
    if (engine.crashRecoverySession) return;
    void (async () => {
      setStarting(true);
      try {
        if (templateId) {
          const template = await workoutTemplatesRepository.getById(templateId);
          const templateExercises = await workoutTemplatesRepository.listExercises(templateId);
          const picks: ExercisePick[] = [];
          for (const te of templateExercises) {
            const pick = await resolvePick(te.exerciseId, te.customExerciseId, te.exerciseNameSnapshot);
            picks.push({ ...pick, targetSets: te.targetSets, targetRestSeconds: te.targetRestSeconds });
          }
          await engine.start({ sourceTemplateId: templateId, templateNameSnapshot: template?.name ?? null, templateExercises: picks });
        } else if (prefillExerciseId) {
          const pick = await resolvePick(prefillExerciseId, null, 'Exercise');
          await engine.start({});
          await engine.addExercise(pick);
        } else {
          await engine.start({});
        }
      } finally {
        setStarting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.loading, engine.session, engine.crashRecoverySession, templateId, prefillExerciseId, editSessionId]);

  const handleAddExercise = () => {
    openExercisePicker((result) => {
      void engine.addExercise(result);
    });
  };

  const handleFinishPress = () => {
    void engine.prepareFinish().then(setFinishDraft);
  };

  const handleDiscard = async () => {
    await engine.discard();
    setShowDiscardConfirm(false);
    router.back();
  };

  if (engine.loading || starting) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]}>
        <View style={styles.centerContent}>
          <MeridianMark variant="seed" size={56} />
        </View>
      </SafeAreaView>
    );
  }

  if (engine.crashRecoverySession) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]}>
        <View style={styles.recoveryContainer}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Resume your workout?
          </Text>
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            You have a workout in progress — resume where you left off, or discard it.
          </Text>
          <PrimaryButton label="Resume" onPress={() => void engine.resumeCrashRecovery()} />
          <SecondaryButton label="Discard" onPress={() => void engine.discardCrashRecovery().then(() => router.back())} />
        </View>
      </SafeAreaView>
    );
  }

  if (!engine.session) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]}>
        <View style={styles.centerContent}>
          <MeridianMark variant="seed" size={56} />
        </View>
      </SafeAreaView>
    );
  }

  const segments: LiftStackSegment[] = engine.exerciseBlocks.flatMap((block) =>
    block.sets
      .filter((s) => s.isCompleted && s.setType === 'working')
      .map((s) => ({ key: s.id, volume: (s.reps ?? 0) * (s.weightKg ?? (s.isBodyweight ? 1 : 0)), isPr: false }))
  );

  const elapsedSeconds = Math.round((now.getTime() - new Date(engine.session.occurredAt).getTime()) / 1000);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable onPress={() => setShowTitleEdit(true)} accessibilityRole="button" accessibilityLabel="Rename workout">
          <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
            {engine.session.title ?? 'Workout'}
          </Text>
        </Pressable>
        <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
          {formatDuration(elapsedSeconds)}
        </Text>
        <SyncStatusPill status="local" />
        <TextButton label="Finish" onPress={handleFinishPress} />
      </View>

      <View style={styles.bodyRow}>
        {engine.exerciseBlocks.length === 0 ? (
          <View style={styles.emptyState}>
            <MeridianMark variant="seed" size={56} />
            <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
              Add your first exercise to start logging.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.exerciseList}>
            {engine.exerciseBlocks.map((block, index) => (
              <ExerciseBlock
                key={block.exerciseOrder}
                block={block}
                unitWeight={unitWeight}
                isFirst={index === 0}
                isLast={index === engine.exerciseBlocks.length - 1}
                onChangeSet={(setId, partial) => void engine.updateSet(setId, partial)}
                onCompleteSet={(setId) => void engine.completeSet(setId)}
                onUncompleteSet={(setId) => void engine.uncompleteSet(setId)}
                onRemoveSet={(setId) => void engine.removeSet(setId)}
                onAddSet={() => void engine.addSet(block.exerciseOrder)}
                onMoveUp={() => void engine.moveExercise(block.exerciseOrder, 'up')}
                onMoveDown={() => void engine.moveExercise(block.exerciseOrder, 'down')}
                onRemoveExercise={() => void engine.removeExercise(block.exerciseOrder)}
              />
            ))}
          </ScrollView>
        )}

        <View style={styles.liftStackRail}>
          <LiftStack variant="live" segments={segments} />
        </View>
      </View>

      <View style={styles.bottomBar}>
        {engine.restTimer.running || engine.restTimer.done ? (
          <RestTimer state={engine.restTimer} onAdjust={engine.adjustRestTimer} onSkip={() => void engine.skipRestTimer()} onDismiss={engine.dismissRestTimer} />
        ) : (
          <View style={styles.bottomActions}>
            <View style={styles.bottomActionItem}>
              <SecondaryButton label="＋ Add exercise" onPress={handleAddExercise} />
            </View>
            <View style={styles.bottomActionItem}>
              <PrimaryButton label="Finish" onPress={handleFinishPress} />
            </View>
          </View>
        )}
      </View>

      <Modal visible={showTitleEdit} transparent animationType="fade" onRequestClose={() => setShowTitleEdit(false)}>
        <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}>
              <TitleEditor
                initial={engine.session.title ?? ''}
                onSave={(title) => {
                  void engine.updateSessionMeta({ title });
                  setShowTitleEdit(false);
                }}
                onCancel={() => setShowTitleEdit(false)}
              />
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      <ConfirmSheet
        visible={showDiscardConfirm}
        title="Discard this workout?"
        body="Every set you logged is deleted and can't be recovered."
        confirmLabel="Discard"
        onConfirm={() => void handleDiscard()}
        onCancel={() => setShowDiscardConfirm(false)}
      />

      {finishDraft && (
        <SaveSheet
          draft={finishDraft}
          segments={segments}
          unitWeight={unitWeight}
          saving={engine.saving}
          suggestedTitle={engine.session.title ?? 'Workout'}
          onDiscard={() => {
            setFinishDraft(null);
            setShowDiscardConfirm(true);
          }}
          onSave={async (title, notes, sessionRpe) => {
            const sessionId = await engine.confirmFinish(finishDraft, title, notes, sessionRpe);
            setFinishDraft(null);
            router.replace({ pathname: '/workout/[id]', params: { id: sessionId } });
          }}
        />
      )}
    </SafeAreaView>
  );
}

function TitleEditor({ initial, onSave, onCancel }: { initial: string; onSave: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(initial);
  return (
    <View style={{ gap: theme.space.md }}>
      <Field label="Workout title" value={title} onChangeText={setTitle} />
      <PrimaryButton label="Save" onPress={() => onSave(title.trim() || 'Workout')} />
      <TextButton label="Cancel" onPress={onCancel} />
    </View>
  );
}

function SaveSheet({
  draft,
  segments,
  unitWeight,
  saving,
  suggestedTitle,
  onDiscard,
  onSave,
}: {
  draft: FinishDraft;
  segments: LiftStackSegment[];
  unitWeight: 'kg' | 'lb';
  saving: boolean;
  suggestedTitle: string;
  onDiscard: () => void;
  onSave: (title: string, notes: string | null, sessionRpe: number | null) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(suggestedTitle);
  const [notes, setNotes] = useState('');
  const [rpe, setRpe] = useState<number | null>(null);

  return (
    <Modal visible transparent animationType="slide">
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <ScrollView contentContainerStyle={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}>
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              Finish workout
            </Text>

            <LiftStack variant="static" segments={segments} height={140} />

            <View style={styles.summaryRow}>
              <SummaryStat label="Volume" value={`${formatVolumeValue(draft.totalVolumeKg, unitWeight)} ${unitWeight}`} />
              <SummaryStat label="Sets" value={String(draft.totalSets)} />
              <SummaryStat label="Duration" value={formatDuration(draft.durationSeconds)} />
              {rpe != null && <SummaryStat label="Load" value={String(Math.round(rpe * (draft.durationSeconds / 60)))} />}
            </View>

            <View>
              <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                Session RPE (optional)
              </Text>
              <Slider
                minimumValue={0}
                maximumValue={10}
                step={1}
                value={rpe ?? 0}
                onValueChange={setRpe}
                accessibilityRole="adjustable"
                accessibilityLabel="Session RPE, 0 to 10"
                accessibilityValue={{ min: 0, max: 10, now: rpe ?? 0 }}
                minimumTrackTintColor={theme.color.accent.data}
              />
              <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                {rpe ?? '—'}
              </Text>
            </View>

            {draft.prEvaluations.length > 0 && <StrengthPrCallout items={draft.prEvaluations} exerciseNamesByRef={draft.exerciseNamesById} unit={unitWeight} />}

            <Field label="Title" value={title} onChangeText={setTitle} maxLength={120} />
            <Field label="Notes (optional)" value={notes} onChangeText={setNotes} maxLength={500} />

            <View style={styles.saveActions}>
              <PrimaryButton label="Save workout" loading={saving} onPress={() => void onSave(title.trim() || suggestedTitle, notes.trim() || null, rpe)} testID="save-workout-button" />
              <SecondaryButton label="Discard" onPress={onDiscard} disabled={saving} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
        {value}
      </Text>
      <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  recoveryContainer: { flex: 1, justifyContent: 'center', paddingHorizontal: theme.screen.edge, gap: theme.space.md },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.screen.edge,
    paddingTop: theme.space.sm,
    gap: theme.space.sm,
  },
  bodyRow: { flex: 1, flexDirection: 'row' },
  exerciseList: { flex: 1, padding: theme.screen.edge, gap: theme.space.sm },
  liftStackRail: { width: 24, alignItems: 'center', paddingVertical: theme.space.md },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.sm, paddingHorizontal: theme.screen.edge },
  bottomBar: { paddingHorizontal: theme.screen.edge, paddingBottom: theme.space.md },
  bottomActions: { flexDirection: 'row', gap: theme.space.sm },
  bottomActionItem: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md },
  summaryRow: { flexDirection: 'row', gap: theme.space.lg },
  saveActions: { gap: theme.space.sm },
});
