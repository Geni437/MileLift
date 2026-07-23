import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { Field } from '../../../src/components/Field';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { SecondaryButton } from '../../../src/components/SecondaryButton';
import { TextButton } from '../../../src/components/TextButton';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { EmptyState } from '../../../src/components/EmptyState';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { ConsentSheet } from '../../../src/components/consent/ConsentSheet';
import { MeridianMark } from '../../../src/components/MeridianMark';
import { MeridianBalance } from '../../../src/components/nutrition/MeridianBalance';
import { MacroBreakdown } from '../../../src/components/nutrition/MacroBreakdown';
import { WaterQuickAdd } from '../../../src/components/nutrition/WaterQuickAdd';
import { ExpenditureRow } from '../../../src/components/nutrition/ExpenditureRow';
import { OverlapAdvisory } from '../../../src/components/nutrition/OverlapAdvisory';
import { MealCard } from '../../../src/components/nutrition/MealCard';
import { useAuth } from '../../../src/state/AuthContext';
import { useProfile } from '../../../src/state/ProfileContext';
import { useConsent } from '../../../src/state/ConsentContext';
import { useDailyNutrition, computeDailyNutritionLocal, listRecentLocalDatesWithActivity, type DailyNutrition } from '../../../src/features/nutrition/useDailyNutrition';
import { foodLogRepository } from '../../../src/db/repositories/foodLogRepository';
import { waterIntakeRepository } from '../../../src/db/repositories/waterIntakeRepository';
import { manualBurnRepository } from '../../../src/db/repositories/manualBurnRepository';
import { generateUuidV4 } from '../../../src/lib/uuid';
import { runSync } from '../../../src/sync/syncEngine';
import type { LocalFoodLogEntry, LocalFoodLogItem, LocalManualBurnLog, ManualBurnEnergySource, UnitVolumeSnapshot } from '../../../src/db/types';

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const eventTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** CORE-08/09/11 — the Food tab (day-first, design doc §B). */
export default function FoodScreen() {
  const { userId } = useAuth();
  const { profile } = useProfile();
  const [segment, setSegment] = useState<'today' | 'history'>('today');
  // No dedicated `unit_volume` profile column exists yet (flagged — see the
  // task report); a reasonable, documented fallback infers it from the
  // user's existing imperial/metric weight-unit preference.
  const unitVolume: UnitVolumeSnapshot = profile?.unitWeight === 'lb' ? 'fl_oz' : 'ml';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Food
          </Text>
          <TextButton label="Sources" onPress={() => router.push('/nutrition-credits')} />
        </View>
        <SegmentedControl
          options={[
            { label: 'Today', value: 'today' },
            { label: 'History', value: 'history' },
          ]}
          value={segment}
          onChange={setSegment}
        />
      </View>

      {segment === 'today' ? <TodayTab userId={userId} unitVolume={unitVolume} /> : <HistoryTab userId={userId} />}
    </SafeAreaView>
  );
}

function TodayTab({ userId, unitVolume }: { userId: string | null; unitVolume: UnitVolumeSnapshot }) {
  const [today] = useState(() => localDateString(new Date()));
  const { data, loading, loadError, refresh } = useDailyNutrition(userId, today);
  const [meals, setMeals] = useState<LocalFoodLogEntry[]>([]);
  const [itemsByMeal, setItemsByMeal] = useState<Map<string, LocalFoodLogItem[]>>(new Map());
  const [showExpenditure, setShowExpenditure] = useState(false);
  const [showLogSheet, setShowLogSheet] = useState(false);
  const [showBurnSheet, setShowBurnSheet] = useState(false);
  const [lastWaterLogId, setLastWaterLogId] = useState<string | null>(null);
  const [undoTimer, setUndoTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [undismissedBurns, setUndismissedBurns] = useState<LocalManualBurnLog[]>([]);

  const loadMeals = useCallback(async () => {
    if (!userId) return;
    const rows = await foodLogRepository.listForLocalDate(userId, today);
    setMeals(rows);
    const map = new Map<string, LocalFoodLogItem[]>();
    for (const meal of rows) {
      map.set(meal.id, await foodLogRepository.getItemsForEntry(meal.id));
    }
    setItemsByMeal(map);
  }, [userId, today]);

  const loadAdvisories = useCallback(async () => {
    if (!userId) return;
    setUndismissedBurns(await manualBurnRepository.listWithUndismissedAdvisory(userId));
  }, [userId]);

  useEffect(() => {
    // Synchronizes today's meals + undismissed overlap-advisory list with
    // the local SQLite store on mount and whenever the loaders change — the
    // documented legitimate effect pattern this codebase uses throughout
    // (see ProfileContext's own note).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMeals();
    void loadAdvisories();
  }, [loadMeals, loadAdvisories]);

  const handleLogWater = async (volumeMl: number) => {
    if (!userId) return;
    const id = generateUuidV4();
    await waterIntakeRepository.create(id, userId, { occurredAt: nowIso(), localDate: today, eventTimezone: eventTimezone(), volumeMl, unitVolumeSnapshot: unitVolume });
    setLastWaterLogId(id);
    if (undoTimer) clearTimeout(undoTimer);
    setUndoTimer(setTimeout(() => setLastWaterLogId(null), 6000));
    void runSync('post-write');
    await refresh();
  };

  const handleUndoWater = async () => {
    if (!lastWaterLogId) return;
    await waterIntakeRepository.softDelete(lastWaterLogId);
    setLastWaterLogId(null);
    void runSync('post-write');
    await refresh();
  };

  if (loading && !data) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <SkeletonBlock height={96} radius={theme.radius.lg} />
        <SkeletonBlock height={64} radius={theme.radius.md} />
        <SkeletonBlock height={120} radius={theme.radius.lg} />
      </ScrollView>
    );
  }

  const hasAnyLogged = !!data && (data.mealCount > 0 || data.caloriesOutKcal > 0 || data.waterMlTotal > 0);

  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        {loadError && (
          <InlineBanner tone="warning" message="Couldn't refresh today's totals — you may be offline. Anything you've logged on this device is still here." />
        )}

        {!hasAnyLogged ? (
          <View style={styles.emptyHero}>
            <MeridianMark variant="seed" size={56} />
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
              The day starts at the origin.
            </Text>
            <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              Log your first food and it settles here — everything you eat and burn balances against this point.
            </Text>
          </View>
        ) : (
          <MeridianBalance variant="live" intakeKcal={data?.caloriesInKcal ?? 0} expenditureKcal={data?.caloriesOutKcal ?? 0} />
        )}
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          Net so far today — MileLift tracks what you took in and burned, not a target.
        </Text>

        {undismissedBurns.map((burn) => (
          <OverlapAdvisory
            key={burn.id}
            events={burn.overlapAdvisory?.overlappingEvents ?? []}
            onKeepBoth={async () => {
              await manualBurnRepository.dismissOverlapAdvisory(burn.id);
              await loadAdvisories();
            }}
            onRemoveBurn={async () => {
              await manualBurnRepository.softDelete(burn.id);
              await manualBurnRepository.dismissOverlapAdvisory(burn.id);
              void runSync('post-write');
              await loadAdvisories();
              await refresh();
            }}
          />
        ))}

        <MacroBreakdown proteinG={data?.totalProteinG ?? null} carbG={data?.totalCarbG ?? null} fatG={data?.totalFatG ?? null} />

        <View style={styles.section}>
          <Pressable onPress={() => setShowExpenditure((v) => !v)} accessibilityRole="button" accessibilityLabel="Toggle calories-out breakdown">
            <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
              Calories out {showExpenditure ? '▾' : '▸'}
            </Text>
          </Pressable>
          {showExpenditure && (
            <>
              <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                Everything you burned today — your tracked runs and lifts, plus anything you logged by hand.
              </Text>
              {(data?.expenditureEvents ?? []).length === 0 ? (
                <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                  Nothing burned yet today.
                </Text>
              ) : (
                data!.expenditureEvents.map((e) => (
                  <ExpenditureRow
                    key={e.timelineEventId}
                    eventType={e.eventType}
                    name={e.label ?? (e.eventType === 'gps_activity' ? 'Run' : e.eventType === 'strength_session' ? 'Workout' : 'Burn')}
                    kcal={e.energyKcal}
                    onPress={
                      e.eventType === 'gps_activity'
                        ? () => router.push({ pathname: '/activity/[id]', params: { id: e.timelineEventId } })
                        : e.eventType === 'strength_session'
                          ? () => router.push({ pathname: '/workout/[id]', params: { id: e.timelineEventId } })
                          : undefined
                    }
                  />
                ))
              )}
            </>
          )}
        </View>

        <View style={styles.section}>
          <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
            Water
          </Text>
          <WaterQuickAdd totalMl={data?.waterMlTotal ?? 0} unit={unitVolume} onLogMl={handleLogWater} canUndo={!!lastWaterLogId} onUndo={handleUndoWater} />
        </View>

        <View style={styles.section}>
          <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
            Meals
          </Text>
          {meals.length === 0 ? (
            <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              Nothing logged yet today.
            </Text>
          ) : (
            meals.map((meal) => (
              <MealCard
                key={meal.id}
                entry={meal}
                items={itemsByMeal.get(meal.id) ?? []}
                onAddFood={() => router.push({ pathname: '/food/log', params: { entryId: meal.id } })}
                onPress={() => router.push({ pathname: '/food/meal/[id]', params: { id: meal.id } })}
                onRetrySync={() => void runSync('manual')}
              />
            ))
          )}
        </View>
      </ScrollView>

      <Pressable
        onPress={() => setShowLogSheet(true)}
        accessibilityRole="button"
        accessibilityLabel="Log food"
        style={[styles.fab, { backgroundColor: theme.color.accent.primary }]}
      >
        <MeridianMark variant="glyph" size={28} />
      </Pressable>

      <LogSheet
        visible={showLogSheet}
        onClose={() => setShowLogSheet(false)}
        onSearchFood={() => {
          setShowLogSheet(false);
          router.push('/food/log');
        }}
        onScanBarcode={() => {
          setShowLogSheet(false);
          router.push('/food/scan');
        }}
        onSavedMeals={() => {
          setShowLogSheet(false);
          router.push('/saved-meals');
        }}
        onLogBurn={() => {
          setShowLogSheet(false);
          setShowBurnSheet(true);
        }}
      />

      <BurnSheet
        visible={showBurnSheet}
        userId={userId}
        onClose={() => setShowBurnSheet(false)}
        onSaved={async () => {
          setShowBurnSheet(false);
          await refresh();
          await loadAdvisories();
        }}
      />
    </>
  );
}

function LogSheet({
  visible,
  onClose,
  onSearchFood,
  onScanBarcode,
  onSavedMeals,
  onLogBurn,
}: {
  visible: boolean;
  onClose: () => void;
  onSearchFood: () => void;
  onScanBarcode: () => void;
  onSavedMeals: () => void;
  onLogBurn: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              Log
            </Text>
            <SecondaryButton label="Search food" onPress={onSearchFood} />
            <SecondaryButton label="Scan a barcode ▸" onPress={onScanBarcode} />
            <SecondaryButton label="Saved meals ▸" onPress={onSavedMeals} />
            <SecondaryButton label="Log a burn" onPress={onLogBurn} />
            <TextButton label="Cancel" onPress={onClose} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function BurnSheet({ visible, userId, onClose, onSaved }: { visible: boolean; userId: string | null; onClose: () => void; onSaved: () => void }) {
  const { categories, grant } = useConsent();
  const hasHealthConsent = !!categories.health.consent;
  const [label, setLabel] = useState('');
  const [kcal, setKcal] = useState('');
  const [duration, setDuration] = useState('');
  const [energySource, setEnergySource] = useState<ManualBurnEnergySource>('user_entered');
  const [showHealthConsent, setShowHealthConsent] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setLabel('');
    setKcal('');
    setDuration('');
    setEnergySource('user_entered');
  };

  const handleSave = async () => {
    if (!userId) return;
    const parsedKcal = Number(kcal);
    if (!label.trim() || !Number.isFinite(parsedKcal) || parsedKcal <= 0) return;
    if (energySource === 'estimated' && !hasHealthConsent) {
      setShowHealthConsent(true);
      return;
    }
    setSaving(true);
    try {
      const now = new Date();
      const id = generateUuidV4();
      await manualBurnRepository.create(id, userId, {
        occurredAt: now.toISOString(),
        localDate: localDateString(now),
        eventTimezone: eventTimezone(),
        energyKcalMagnitude: parsedKcal,
        label: label.trim(),
        activityTypeCode: null,
        durationMinutes: duration.trim() ? Math.max(0, Math.round(Number(duration))) : null,
        energySource,
        notes: null,
      });
      void runSync('post-write');
      reset();
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
          <ScrollView contentContainerStyle={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              Log a burn
            </Text>
            <Field label="What did you do?" value={label} onChangeText={setLabel} placeholder="Tennis, yoga class…" />
            <Field label="Calories burned" value={kcal} onChangeText={setKcal} keyboardType="decimal-pad" />
            <Field label="Duration (minutes, optional)" value={duration} onChangeText={setDuration} keyboardType="number-pad" />
            <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              How was this number set?
            </Text>
            <View style={styles.sourceRow}>
              <SourceChip label="I entered it" selected={energySource === 'user_entered'} onPress={() => setEnergySource('user_entered')} />
              <SourceChip label="Estimate it for me" selected={energySource === 'estimated'} onPress={() => setEnergySource('estimated')} />
            </View>
            <PrimaryButton label="Log burn" onPress={() => void handleSave()} loading={saving} disabled={!label.trim() || !kcal.trim()} />
            <TextButton label="Cancel" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>

      <ConsentSheet
        visible={showHealthConsent}
        category="health"
        loading={consentLoading}
        onAllow={async () => {
          setConsentLoading(true);
          await grant('health');
          setConsentLoading(false);
          setShowHealthConsent(false);
        }}
        onDecline={() => setShowHealthConsent(false)}
      />
    </Modal>
  );
}

function SourceChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.sourceChip, { backgroundColor: selected ? theme.color.accent.primary : theme.color.bg.inset }]}
    >
      <Text style={[theme.type.label, { color: selected ? theme.color.text.onAccent : theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
        {label}
      </Text>
    </Pressable>
  );
}

type DayRow = { localDate: string; nutrition: DailyNutrition };

function HistoryTab({ userId }: { userId: string | null }) {
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<DayRow[]>([]);

  useEffect(() => {
    (async () => {
      if (!userId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const dates = await listRecentLocalDatesWithActivity(userId);
      const rows = await Promise.all(dates.map(async (localDate) => ({ localDate, nutrition: await computeDailyNutritionLocal(userId, localDate) })));
      setDays(rows);
      setLoading(false);
    })();
  }, [userId]);

  if (loading) {
    return (
      <View style={styles.content}>
        <SkeletonBlock height={72} radius={theme.radius.md} />
        <SkeletonBlock height={72} radius={theme.radius.md} />
      </View>
    );
  }

  if (days.length === 0) {
    return <EmptyState title="No food log history yet." body="Log a meal and it'll show up here, day by day." />;
  }

  return (
    <FlatList
      data={days}
      keyExtractor={(d) => d.localDate}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push({ pathname: '/food/log', params: { historyDate: item.localDate } })}
          accessibilityRole="button"
          accessibilityLabel={`${item.localDate}: in ${Math.round(item.nutrition.caloriesInKcal)}, out ${Math.round(item.nutrition.caloriesOutKcal)}, net ${Math.round(item.nutrition.netKcal)} kilocalories`}
          style={[styles.dayRow, { backgroundColor: theme.color.bg.raised }]}
        >
          <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
            {item.localDate}
          </Text>
          <MeridianBalance variant="static" intakeKcal={item.nutrition.caloriesInKcal} expenditureKcal={item.nutrition.caloriesOutKcal} />
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            In {Math.round(item.nutrition.caloriesInKcal)} · Out {Math.round(item.nutrition.caloriesOutKcal)} · Net {Math.round(item.nutrition.netKcal)} · {item.nutrition.mealCount} meal
            {item.nutrition.mealCount === 1 ? '' : 's'}
          </Text>
        </Pressable>
      )}
      ListFooterComponent={
        <Text style={[theme.type.caption, styles.footerNote, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          That&apos;s the start of your food log.
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md, gap: theme.space.sm },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  content: { padding: theme.screen.edge, gap: theme.space.lg, paddingBottom: theme.space.colossal },
  section: { gap: theme.space.xs },
  emptyHero: { alignItems: 'center', gap: theme.space.sm, paddingVertical: theme.space.xl },
  fab: {
    position: 'absolute',
    right: theme.screen.edge,
    bottom: theme.space.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md },
  sourceRow: { flexDirection: 'row', gap: theme.space.xs },
  sourceChip: { minHeight: theme.touchTarget.min, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, justifyContent: 'center' },
  dayRow: { borderRadius: theme.radius.lg, padding: theme.space.md, gap: theme.space.xs, marginBottom: theme.space.sm },
  footerNote: { textAlign: 'center', paddingVertical: theme.space.lg },
});
