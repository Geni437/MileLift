import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import { theme } from '../../src/theme';
import { Field } from '../../src/components/Field';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { SecondaryButton } from '../../src/components/SecondaryButton';
import { TextButton } from '../../src/components/TextButton';
import { EmptyState } from '../../src/components/EmptyState';
import { ConsentSheet } from '../../src/components/consent/ConsentSheet';
import { PhotoTile } from '../../src/components/strength/PhotoTile';
import { LockGlyph } from '../../src/components/LockGlyph';
import { bodyweightRepository } from '../../src/db/repositories/bodyweightRepository';
import { bodyMeasurementsRepository } from '../../src/db/repositories/bodyMeasurementsRepository';
import { progressPhotosRepository } from '../../src/db/repositories/progressPhotosRepository';
import { localPreferencesRepository } from '../../src/db/repositories/localPreferencesRepository';
import { generateUuidV4 } from '../../src/lib/uuid';
import { runSync } from '../../src/sync/syncEngine';
import { useAuth } from '../../src/state/AuthContext';
import { useProfile } from '../../src/state/ProfileContext';
import { useConsent } from '../../src/state/ConsentContext';
import { formatWeightValue } from '../../src/lib/format';
import { photoLibraryPermission } from '../../src/permissions/cameraPermission';
import type { LocalBodyweightLog, LocalProgressPhoto, MeasurementKind, PhotoPose } from '../../src/db/types';

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Humanized display labels for the internal `measurement_kind` enum — never rendered raw in the UI. */
const MEASUREMENT_KIND_LABELS: Record<MeasurementKind, string> = {
  waist: 'Waist',
  chest: 'Chest',
  hips: 'Hips',
  thigh: 'Thigh',
  biceps: 'Biceps',
  calf: 'Calf',
  neck: 'Neck',
  shoulders: 'Shoulders',
  forearm: 'Forearm',
  body_fat_pct: 'Body fat %',
};

/** CORE-16 — Body landing: current weight, latest measurements, progress photos (the gated section). */
export default function BodyScreen() {
  const { userId } = useAuth();
  const { profile } = useProfile();
  const { categories, grant } = useConsent();
  const unitWeight = profile?.unitWeight ?? 'kg';

  const [latestWeight, setLatestWeight] = useState<LocalBodyweightLog | null>(null);
  const [latestValues, setLatestValues] = useState<Map<MeasurementKind, { value: number; unitSnapshot: string }>>(new Map());
  const [photos, setPhotos] = useState<LocalProgressPhoto[]>([]);
  const [photosAlwaysReveal, setPhotosAlwaysReveal] = useState(false);
  const [showWeightSheet, setShowWeightSheet] = useState(false);
  const [showMeasurementSheet, setShowMeasurementSheet] = useState(false);
  const [showHealthConsent, setShowHealthConsent] = useState(false);
  const [showBodyImageConsent, setShowBodyImageConsent] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<'weight' | 'measurement' | 'photo' | null>(null);

  const hasHealthConsent = !!categories.health.consent;
  const hasBodyImageConsent = !!categories.body_image.consent;

  const load = React.useCallback(async () => {
    if (!userId) return;
    const [weight, values, photoList, prefs] = await Promise.all([
      bodyweightRepository.getLatest(userId),
      bodyMeasurementsRepository.latestValuePerKind(userId),
      progressPhotosRepository.listForUser(userId),
      localPreferencesRepository.get(userId),
    ]);
    setLatestWeight(weight);
    setLatestValues(values);
    setPhotos(photoList);
    setPhotosAlwaysReveal(prefs.photosAlwaysReveal);
  }, [userId]);

  const handleToggleAlwaysReveal = async () => {
    if (!userId) return;
    const next = !photosAlwaysReveal;
    setPhotosAlwaysReveal(next);
    await localPreferencesRepository.setPhotosAlwaysReveal(userId, next);
  };

  useEffect(() => {
    // Synchronizes local body/photo state with the local SQLite store on
    // mount / user change — same legitimate pattern as ProfileContext's own effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const requireHealthConsent = (action: 'weight' | 'measurement') => {
    if (hasHealthConsent) {
      if (action === 'weight') setShowWeightSheet(true);
      else setShowMeasurementSheet(true);
      return;
    }
    setPendingAction(action);
    setShowHealthConsent(true);
  };

  const handleAllowHealth = async () => {
    setConsentLoading(true);
    await grant('health');
    setConsentLoading(false);
    setShowHealthConsent(false);
    if (pendingAction === 'weight') setShowWeightSheet(true);
    if (pendingAction === 'measurement') setShowMeasurementSheet(true);
    setPendingAction(null);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Body
          </Text>
          <TextButton label="Close" onPress={() => router.back()} />
        </View>

        <View style={styles.section}>
          <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            Current weight
          </Text>
          <Text style={[theme.type.metricXl, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.4}>
            {latestWeight ? `${formatWeightValue(latestWeight.weightKg, unitWeight)} ${unitWeight}` : '--'}
          </Text>
          <PrimaryButton label="Log weight" onPress={() => requireHealthConsent('weight')} />
        </View>

        <View style={styles.section}>
          <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            Measurements
          </Text>
          {latestValues.size === 0 ? (
            <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              No measurements logged yet.
            </Text>
          ) : (
            // Metric-face value + humanized label dual readout — mirrors the
            // SaveSheet SummaryStat pattern, never the raw internal enum
            // (`waist`, `hips`, ...) as plain body text.
            <View style={styles.measurementGrid}>
              {Array.from(latestValues.entries()).map(([kind, v]) => (
                <View key={kind} style={styles.measurementItem}>
                  <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                    {v.value} {v.unitSnapshot}
                  </Text>
                  <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                    {MEASUREMENT_KIND_LABELS[kind].toUpperCase()}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <SecondaryButton label="Log measurements" onPress={() => requireHealthConsent('measurement')} />
        </View>

        <View style={styles.section}>
          <View style={styles.photosHeader}>
            <LockGlyph size={18} />
            <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              Progress photos · Only you can see these
            </Text>
          </View>

          {!hasBodyImageConsent ? (
            <View style={styles.declinedState}>
              <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                Progress photos are off. Turn them on to start a private photo timeline.
              </Text>
              <TextButton label="Turn on" onPress={() => setShowBodyImageConsent(true)} />
            </View>
          ) : photos.length === 0 ? (
            <EmptyState title="No progress photos yet." body="Add one to start comparing over time." actionLabel="＋ Add photo" onAction={() => void handleAddPhoto()} />
          ) : (
            <>
              <View style={styles.photoGrid}>
                {photos.slice(0, 6).flatMap((occasion) =>
                  occasion.images.map((img) => (
                    <View key={img.id} style={styles.photoTileWrap}>
                      <PhotoTile uri={img.localUri} label={img.pose} alwaysReveal={photosAlwaysReveal} />
                    </View>
                  ))
                )}
              </View>
              <Pressable
                onPress={() => void handleToggleAlwaysReveal()}
                accessibilityRole="switch"
                accessibilityState={{ checked: photosAlwaysReveal }}
                accessibilityLabel="Always reveal photos on this device"
                style={styles.alwaysRevealRow}
              >
                <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                  Always reveal on this device
                </Text>
                <Text style={[theme.type.label, { color: photosAlwaysReveal ? theme.color.accent.primary : theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                  {photosAlwaysReveal ? 'On' : 'Off'}
                </Text>
              </Pressable>
              <View style={styles.photoActionsRow}>
                <TextButton label="＋ Add photo" onPress={() => void handleAddPhoto()} />
                <TextButton label="Compare" onPress={() => router.push('/body/photos')} />
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <BodyweightSheet
        visible={showWeightSheet}
        userId={userId}
        unitWeight={unitWeight}
        onClose={() => setShowWeightSheet(false)}
        onSaved={async () => {
          setShowWeightSheet(false);
          await load();
          void runSync('post-write');
        }}
      />

      <MeasurementSheet
        visible={showMeasurementSheet}
        userId={userId}
        onClose={() => setShowMeasurementSheet(false)}
        onSaved={async () => {
          setShowMeasurementSheet(false);
          await load();
          void runSync('post-write');
        }}
      />

      <ConsentSheet
        visible={showHealthConsent}
        category="health"
        loading={consentLoading}
        onAllow={() => void handleAllowHealth()}
        onDecline={() => {
          setShowHealthConsent(false);
          setPendingAction(null);
        }}
      />

      <ConsentSheet
        visible={showBodyImageConsent}
        category="body_image"
        loading={consentLoading}
        onAllow={async () => {
          setConsentLoading(true);
          await grant('body_image');
          setConsentLoading(false);
          setShowBodyImageConsent(false);
        }}
        onDecline={() => setShowBodyImageConsent(false)}
      />
    </SafeAreaView>
  );

  async function handleAddPhoto() {
    if (!hasBodyImageConsent) {
      setShowBodyImageConsent(true);
      return;
    }
    if (!userId) return;

    // "Choose from library" skips the camera consent sub-step entirely
    // (design doc CORE-16: body_image is the primary gate; camera is only
    // the capture mechanism) — this simplified first pass always picks from
    // the library, never launching the camera directly, so no separate E3
    // camera ConsentSheet flow is triggered here. A "Take photo" entry point
    // with its own camera-consent sub-step is a documented follow-up.
    const libStatus = await photoLibraryPermission.getStatus();
    if (libStatus !== 'granted') {
      const requested = await photoLibraryPermission.request();
      if (requested !== 'granted') return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (result.canceled || result.assets.length === 0) return;

    const occasionId = generateUuidV4();
    const now = new Date();
    await progressPhotosRepository.create(occasionId, userId, { occurredAt: now.toISOString(), localDate: localDate(now), eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, notes: null });
    const pose: PhotoPose = 'front';
    await progressPhotosRepository.addImage(generateUuidV4(), occasionId, pose, result.assets[0]!.uri);
    void runSync('post-write');
    await load();
  }
}

function BodyweightSheet({
  visible,
  userId,
  unitWeight,
  onClose,
  onSaved,
}: {
  visible: boolean;
  userId: string | null;
  unitWeight: 'kg' | 'lb';
  onClose: () => void;
  onSaved: () => void;
}) {
  const [weight, setWeight] = useState('');
  const [bodyFat, setBodyFat] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!userId) return;
    const parsed = Number(weight);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setSaving(true);
    try {
      const kg = unitWeight === 'lb' ? parsed * 0.45359237 : parsed;
      const now = new Date();
      await bodyweightRepository.create(generateUuidV4(), userId, {
        occurredAt: now.toISOString(),
        localDate: localDate(now),
        eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weightKg: kg,
        unitWeightSnapshot: unitWeight,
        bodyFatPct: bodyFat.trim() ? Number(bodyFat) : null,
        notes: null,
      });
      setWeight('');
      setBodyFat('');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}>
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              Log weight
            </Text>
            <Field label={`Weight (${unitWeight})`} value={weight} onChangeText={setWeight} keyboardType="decimal-pad" />
            <Field label="Body fat % (optional)" value={bodyFat} onChangeText={setBodyFat} keyboardType="decimal-pad" />
            <PrimaryButton label="Save" onPress={() => void handleSave()} loading={saving} disabled={!weight.trim()} />
            <TextButton label="Cancel" onPress={onClose} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const MEASUREMENT_KINDS: MeasurementKind[] = ['waist', 'chest', 'hips', 'thigh', 'biceps', 'calf', 'neck', 'shoulders'];

function MeasurementSheet({ visible, userId, onClose, onSaved }: { visible: boolean; userId: string | null; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!userId) return;
    const entries = Object.entries(values).filter(([, v]) => v.trim());
    if (entries.length === 0) return;
    setSaving(true);
    try {
      const now = new Date();
      await bodyMeasurementsRepository.create(generateUuidV4(), userId, {
        occurredAt: now.toISOString(),
        localDate: localDate(now),
        eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        notes: null,
        values: entries.map(([kind, v]) => ({ measurementKind: kind as MeasurementKind, value: Number(v), unitSnapshot: 'cm' as const })),
      });
      setValues({});
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <ScrollView contentContainerStyle={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}>
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              Log measurements
            </Text>
            <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              Add only the sites you measured.
            </Text>
            {MEASUREMENT_KINDS.map((kind) => (
              <Field key={kind} label={`${kind} (cm)`} value={values[kind] ?? ''} onChangeText={(v) => setValues((prev) => ({ ...prev, [kind]: v }))} keyboardType="decimal-pad" />
            ))}
            <PrimaryButton label="Save" onPress={() => void handleSave()} loading={saving} />
            <TextButton label="Cancel" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.lg },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  section: { gap: theme.space.sm },
  photosHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  declinedState: { gap: theme.space.xs },
  measurementGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md },
  measurementItem: { gap: 2, minWidth: 80 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },
  photoTileWrap: { width: '30%' },
  photoActionsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  alwaysRevealRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: theme.touchTarget.min },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md },
});
