import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { SecondaryButton } from '../../src/components/SecondaryButton';
import { TextButton } from '../../src/components/TextButton';
import { Field } from '../../src/components/Field';
import { InlineBanner } from '../../src/components/InlineBanner';
import { SkeletonBlock } from '../../src/components/SkeletonBlock';
import { ConfirmSheet } from '../../src/components/ConfirmSheet';
import { ConsentSheet } from '../../src/components/consent/ConsentSheet';
import { MetricStat } from '../../src/components/activity/MetricStat';
import { MetricBar, type MetricBarItem } from '../../src/components/activity/MetricBar';
import { MeridianTrace } from '../../src/components/activity/MeridianTrace';
import { GpsSignal } from '../../src/components/activity/GpsSignal';
import { RecordControl } from '../../src/components/activity/RecordControl';
import { TypePicker } from '../../src/components/activity/TypePicker';
import { PrCallout } from '../../src/components/activity/PrCallout';
import { RouteMap } from '../../src/components/activity/RouteMap';
import { formatDistanceValue, formatDuration, formatElevation, formatPace } from '../../src/lib/format';
import { activityTypesRepository } from '../../src/db/repositories/activityTypesRepository';
import { localPreferencesRepository, type RecordingHeroMetric } from '../../src/db/repositories/localPreferencesRepository';
import { useRecordingEngine, type FinishDraft } from '../../src/features/activity/useRecordingEngine';
import { useAuth } from '../../src/state/AuthContext';
import { useProfile } from '../../src/state/ProfileContext';
import { useConsent } from '../../src/state/ConsentContext';
import type { ActivityType } from '../../src/db/types';

/** Shape constant for the live MeridianTrace's asymptotic growth curve — see the `liveTraceProgress` comment below. Not a duration target. */
const LIVE_TRACE_REFERENCE_SECONDS = 20 * 60;

export default function RecordScreen() {
  const { userId } = useAuth();
  const { profile } = useProfile();
  const { categories, grant, decline } = useConsent();
  const unitDistance = profile?.unitDistance ?? 'km';

  const engine = useRecordingEngine({ userId: userId ?? '', unitDistance });
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [heroMetric, setHeroMetric] = useState<RecordingHeroMetric>('duration');
  const [showLocationConsent, setShowLocationConsent] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [finishDraft, setFinishDraft] = useState<FinishDraft | null>(null);
  const [recoveredTypeCode, setRecoveredTypeCode] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    void activityTypesRepository.getAll().then((types) => {
      setActivityTypes(types);
      if (!engine.selectedType && types.length > 0) engine.setSelectedType(types[0]);
    });
    if (userId) {
      void localPreferencesRepository.get(userId).then((p) => setHeroMetric(p.recordingHeroMetric));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    // Synchronizes the engine's selected type with the crash-recovered
    // session's type code once the (asynchronously loaded) activity-type
    // catalog is available — the same legitimate "sync with an external
    // system once it's ready" case ProfileContext/ConsentContext's own
    // effects are documented against, not a React-Compiler hazard (this
    // project doesn't use the compiler).
    /* eslint-disable react-hooks/set-state-in-effect */
    if (recoveredTypeCode && activityTypes.length > 0) {
      const type = activityTypes.find((t) => t.code === recoveredTypeCode);
      if (type) engine.setSelectedType(type);
      setRecoveredTypeCode(null);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveredTypeCode, activityTypes]);

  const hasLocationConsent = !!categories.location.consent;
  const locationConsentDeclinedOrRevoked = engine.session?.locationDeclined ?? false;

  const cycleHero = () => {
    // Only offer metrics that apply to the selected type (design doc CORE-01
    // TypePicker note: "is_distance_based = false ... hides Distance/Pace
    // and shows Duration-only. The screen is a function of the type's
    // metadata, not hardcoded per type.").
    const order: RecordingHeroMetric[] = engine.selectedType?.isDistanceBased ? ['duration', 'distance', 'pace'] : ['duration'];
    const next = order[(order.indexOf(heroMetric) + 1) % order.length];
    setHeroMetric(next);
    if (userId) void localPreferencesRepository.setRecordingHeroMetric(userId, next);
  };

  const handleStartPress = async () => {
    if (!engine.selectedType) return;
    if (engine.selectedType.supportsGps && !hasLocationConsent) {
      setShowLocationConsent(true);
      return;
    }
    setStarting(true);
    try {
      await engine.start(engine.selectedType.supportsGps);
    } finally {
      setStarting(false);
    }
  };

  const handleAllowLocation = async () => {
    setConsentLoading(true);
    const result = await grant('location');
    setConsentLoading(false);
    setShowLocationConsent(false);
    if (result.ok && result.osStatus === 'granted') {
      setStarting(true);
      try {
        await engine.start(true);
      } finally {
        setStarting(false);
      }
    } else {
      // OS-denied/blocked: graceful degrade — recording still starts, Duration-only (design doc CORE-01).
      setStarting(true);
      try {
        await engine.start(false);
      } finally {
        setStarting(false);
      }
    }
  };

  const handleDeclineLocation = async () => {
    decline('location');
    setShowLocationConsent(false);
    setStarting(true);
    try {
      await engine.start(false);
    } finally {
      setStarting(false);
    }
  };

  const handleFinishPress = () => {
    void engine.prepareFinish().then((draft) => setFinishDraft(draft));
  };

  const handleDiscardPress = () => {
    setShowDiscardConfirm(true);
  };

  const handleConfirmDiscard = async () => {
    setDiscarding(true);
    try {
      await engine.discard();
      setShowDiscardConfirm(false);
      router.back();
    } finally {
      setDiscarding(false);
    }
  };

  if (engine.loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]}>
        <View style={styles.content}>
          <SkeletonBlock height={64} width={160} radius={theme.radius.md} />
          <SkeletonBlock height={180} radius={theme.radius.lg} />
          <SkeletonBlock height={60} radius={theme.radius.md} />
        </View>
      </SafeAreaView>
    );
  }

  if (engine.crashRecoverySession) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]}>
        <View style={styles.recoveryContainer}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>Resume your recording?</Text>
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            You have a recording in progress — resume where you left off, or discard it.
          </Text>
          <PrimaryButton
            label="Resume"
            onPress={() => {
              void engine.resumeCrashRecovery().then((typeCode) => {
                if (typeCode) setRecoveredTypeCode(typeCode);
              });
            }}
          />
          <SecondaryButton label="Discard" onPress={() => void engine.discardCrashRecovery()} />
        </View>
      </SafeAreaView>
    );
  }

  // A remembered hero of "distance"/"pace" from a previous distance-based
  // type must not apply to a non-distance type (e.g. switching to Yoga) —
  // fall back to Duration for display without mutating the stored
  // preference (it's still valid the next time a distance-based type is picked).
  const effectiveHeroMetric: RecordingHeroMetric = engine.selectedType?.isDistanceBased ? heroMetric : 'duration';

  const heroValue =
    effectiveHeroMetric === 'duration'
      ? formatDuration(engine.liveMovingSeconds)
      : effectiveHeroMetric === 'distance'
        ? formatDistanceValue(engine.liveDistanceM, unitDistance)
        : formatPace(engine.currentPaceMps, unitDistance);
  const heroUnit = effectiveHeroMetric === 'distance' ? unitDistance : effectiveHeroMetric === 'pace' ? `/${unitDistance}` : undefined;
  const heroLabel = effectiveHeroMetric === 'duration' ? 'Duration' : effectiveHeroMetric === 'distance' ? 'Distance' : 'Pace';

  const secondaryItems: MetricBarItem[] = [];
  if (effectiveHeroMetric !== 'distance' && engine.selectedType?.isDistanceBased) {
    secondaryItems.push({ key: 'distance', value: formatDistanceValue(engine.liveDistanceM, unitDistance), unit: unitDistance, label: 'Distance' });
  }
  if (effectiveHeroMetric !== 'pace' && engine.selectedType?.isDistanceBased) {
    secondaryItems.push({ key: 'pace', value: formatPace(engine.currentPaceMps, unitDistance), label: 'Pace' });
  }
  if (engine.selectedType?.tracksElevation) {
    secondaryItems.push({ key: 'elev', value: formatElevation(engine.liveElevationGainM), unit: 'm', label: 'Elevation' });
  }

  const status = engine.status;
  const gpsGranted = engine.selectedType?.supportsGps && !locationConsentDeclinedOrRevoked;

  // screens-phase-1.md §A: the live MeridianTrace "grows continuously — it
  // is not a fill-to-100% bar (a free run has no target); it is a living
  // axis." An elapsed/3600s fill would sit maxed-out and unmoving for the
  // rest of any run over an hour, which is exactly the rejected pattern.
  // Judgment call: use an asymptotic curve (elapsed / (elapsed + reference))
  // instead — it keeps inching forward for as long as the run runs (it
  // mathematically never reaches 1 for finite elapsed, so there is no
  // hidden target line to hit), while still moving briskly during a
  // "typical" run length so the trace doesn't read as inert early on.
  // `LIVE_TRACE_REFERENCE_SECONDS` is a growth-curve shape constant, not a
  // duration target — it is never surfaced to the user.
  const liveTraceProgress = engine.liveElapsedSeconds / (engine.liveElapsedSeconds + LIVE_TRACE_REFERENCE_SECONDS);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.color.bg.canvas }]}>
      <View style={styles.topBar}>
        <View style={styles.typePickerWrap}>
          <TypePicker
            types={activityTypes}
            selectedCode={engine.selectedType?.code ?? null}
            onSelect={(t) => engine.setSelectedType(t)}
            locked={status !== 'ready'}
          />
        </View>
        {engine.selectedType?.supportsGps && !locationConsentDeclinedOrRevoked && <GpsSignal state={engine.gpsSignal} />}
      </View>

      <View style={styles.content}>
        {status === 'ready' && (
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            Getting a GPS fix — you can start now, the route begins once it locks.
          </Text>
        )}

        {locationConsentDeclinedOrRevoked && status !== 'ready' && (
          <InlineBanner
            tone="warning"
            message="No route without location. Recording time and heart rate instead. Turn on location."
            actionLabel="Turn on location"
            onAction={() => setShowLocationConsent(true)}
          />
        )}

        <Pressable onPress={cycleHero} accessibilityRole="button" accessibilityLabel={`${heroLabel}: ${heroValue}. Tap to change hero metric.`}>
          <MetricStat value={heroValue} unit={heroUnit} label={heroLabel} size="hero" />
        </Pressable>

        {/* screens-phase-1.md: "a secondary type.metricSm 'Elapsed' (the
            spine's duration_seconds, keeps counting through pauses) sits
            under the hero so both model fields are honest and visible." The
            hero above is moving time (engine.liveMovingSeconds, stops while
            paused); this is the spine's duration_seconds, which does not. */}
        <Text
          style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.secondary }]}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel={`Elapsed: ${formatDuration(engine.liveElapsedSeconds)}, keeps counting through pauses`}
        >
          Elapsed {formatDuration(engine.liveElapsedSeconds)}
        </Text>

        {showMap && gpsGranted ? (
          <RouteMap isOwnActivity points={engine.points} bounds={null} height={180} />
        ) : (
          <MeridianTrace variant={status === 'ready' ? 'empty' : 'live'} progress={liveTraceProgress} />
        )}

        <MetricBar items={secondaryItems} size="inline" />

        {gpsGranted && (
          <TextButton label={showMap ? 'Hide map' : 'Show map'} onPress={() => setShowMap((v) => !v)} />
        )}
      </View>

      <View style={styles.controlWrap}>
        <RecordControl
          status={status}
          starting={starting}
          onStart={() => void handleStartPress()}
          onPause={() => void engine.pause()}
          onResume={() => void engine.resume()}
          onFinish={handleFinishPress}
        />
      </View>

      <ConsentSheet
        visible={showLocationConsent}
        category="location"
        loading={consentLoading}
        onAllow={() => void handleAllowLocation()}
        onDecline={() => void handleDeclineLocation()}
      />

      <ConfirmSheet
        visible={showDiscardConfirm}
        title="Discard this recording?"
        body="The route and time are deleted and can't be recovered."
        confirmLabel="Discard"
        loading={discarding}
        onConfirm={() => void handleConfirmDiscard()}
        onCancel={() => setShowDiscardConfirm(false)}
      />

      {finishDraft && (
        <SaveSheet
          draft={finishDraft}
          unit={unitDistance}
          saving={engine.saving}
          onDiscard={() => {
            setFinishDraft(null);
            handleDiscardPress();
          }}
          onSave={async (title, description) => {
            const result = await engine.confirmSave(finishDraft, title, description);
            setFinishDraft(null);
            router.replace({ pathname: '/activity/[id]', params: { id: result.activityId } });
          }}
        />
      )}
    </SafeAreaView>
  );
}

function SaveSheet({
  draft,
  unit,
  saving,
  onDiscard,
  onSave,
}: {
  draft: FinishDraft;
  unit: 'km' | 'mi';
  saving: boolean;
  onDiscard: () => void;
  onSave: (title: string, description: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(draft.suggestedTitle);
  const [description, setDescription] = useState('');

  const summaryItems: MetricBarItem[] = [];
  if (draft.distanceM != null) summaryItems.push({ key: 'distance', value: formatDistanceValue(draft.distanceM, unit), unit, label: 'Distance' });
  summaryItems.push({ key: 'moving', value: formatDuration(draft.movingTimeSeconds), label: 'Moving time' });
  if (draft.averageSpeedMps != null) summaryItems.push({ key: 'pace', value: formatPace(draft.averageSpeedMps, unit), label: 'Avg pace' });
  if (draft.elevationGainM != null) summaryItems.push({ key: 'elev', value: formatElevation(draft.elevationGainM), unit: 'm', label: 'Elevation gain' });

  return (
    <Modal visible transparent animationType="slide">
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>Finish activity</Text>
            <MetricBar items={summaryItems} size="inline" />
            <MeridianTrace variant="static" height={48} />
            {draft.prEvaluations.length > 0 && (
              <PrCallout activityTypeName={draft.activityTypeName} unit={unit} items={draft.prEvaluations} />
            )}
            <Field label="Title" value={title} onChangeText={setTitle} maxLength={120} />
            <Field label="Description (optional)" value={description} onChangeText={setDescription} maxLength={500} />

            <View style={styles.saveActions}>
              <PrimaryButton
                label="Save activity"
                loading={saving}
                onPress={() => void onSave(title.trim() || draft.suggestedTitle, description.trim())}
                testID="save-activity-button"
              />
              <SecondaryButton label="Discard" onPress={onDiscard} disabled={saving} />
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: theme.screen.edge,
    paddingTop: theme.space.sm,
    gap: theme.space.sm,
  },
  typePickerWrap: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.screen.edge,
    paddingTop: theme.space.lg,
    gap: theme.space.md,
  },
  controlWrap: {
    paddingHorizontal: theme.screen.edge,
    paddingBottom: theme.space.lg,
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
  saveActions: {
    gap: theme.space.sm,
  },
  recoveryContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.screen.edge,
    gap: theme.space.md,
  },
});
