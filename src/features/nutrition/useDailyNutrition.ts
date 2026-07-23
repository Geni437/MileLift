import { useCallback, useEffect, useState } from 'react';
import * as Network from 'expo-network';

import { supabase } from '../../lib/supabase';
import { getDb } from '../../db/client';
import { foodLogRepository } from '../../db/repositories/foodLogRepository';
import { waterIntakeRepository } from '../../db/repositories/waterIntakeRepository';
import { manualBurnRepository } from '../../db/repositories/manualBurnRepository';
import type { ExpenditureEventType } from '../../components/nutrition/ExpenditureRow';

export type ExpenditureEvent = {
  timelineEventId: string;
  eventType: ExpenditureEventType;
  occurredAt: string;
  energyKcal: number; // negative magnitude
  label: string | null;
};

export type DailyNutrition = {
  localDate: string;
  caloriesInKcal: number;
  caloriesOutKcal: number;
  netKcal: number;
  expenditureEvents: ExpenditureEvent[];
  totalProteinG: number | null;
  totalCarbG: number | null;
  totalFatG: number | null;
  mealCount: number;
  waterMlTotal: number;
  /** True when this reflects a local-only fallback because the day's authoritative RPC read failed/was unreachable (design doc §CORE-08 "Offline / cold-start load failed" state). */
  isLocalFallback: boolean;
};

type BalanceRpcResponse = {
  data?: {
    local_date: string;
    calories_in_kcal: number;
    calories_out_kcal: number;
    net_kcal: number;
    intake_event_count: number;
    expenditure_events: { timeline_event_id: string; event_type: string; source_module: string; occurred_at: string; duration_seconds: number | null; energy_kcal: number; label: string | null }[];
  };
  error?: { code: string; message: string };
};

type MacrosRpcResponse = {
  data?: { local_date: string; total_energy_kcal: number; total_protein_g: number | null; total_carb_g: number | null; total_fat_g: number | null; meal_count: number; water_ml_total: number };
  error?: { code: string; message: string };
};

async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return !!state.isConnected && state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

/** Reads this device's own tracked-workout expenditure locally (Module A `activities` + Module C `workout_sessions`) — the offline-fallback equivalent of `get_daily_energy_balance_v1`'s cross-module read (architecture §4.2), scoped to this local store only (a second device's tracked workouts aren't visible until the next sync). */
async function localExpenditureEvents(userId: string, localDate: string): Promise<ExpenditureEvent[]> {
  const db = await getDb();
  const activities = await db.getAllAsync<{ id: string; occurred_at: string; energy_kcal: number | null }>(
    `SELECT id, occurred_at, energy_kcal FROM activities WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL AND energy_kcal IS NOT NULL AND energy_kcal < 0`,
    [userId, localDate]
  );
  const sessions = await db.getAllAsync<{ id: string; occurred_at: string; energy_kcal: number | null }>(
    `SELECT id, occurred_at, energy_kcal FROM workout_sessions WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL AND is_finished = 1 AND energy_kcal IS NOT NULL AND energy_kcal < 0`,
    [userId, localDate]
  );
  return [
    ...activities.map((a) => ({ timelineEventId: a.id, eventType: 'gps_activity' as const, occurredAt: a.occurred_at, energyKcal: a.energy_kcal!, label: null })),
    ...sessions.map((s) => ({ timelineEventId: s.id, eventType: 'strength_session' as const, occurredAt: s.occurred_at, energyKcal: s.energy_kcal!, label: null })),
  ];
}

async function localFallback(userId: string, localDate: string): Promise<DailyNutrition> {
  const [meals, burns, water, tracked] = await Promise.all([
    foodLogRepository.listForLocalDate(userId, localDate),
    manualBurnRepository.listForLocalDate(userId, localDate),
    waterIntakeRepository.listForLocalDate(userId, localDate),
    localExpenditureEvents(userId, localDate),
  ]);

  const caloriesInKcal = meals.reduce((sum, m) => sum + m.totalEnergyKcal, 0);
  const burnEvents: ExpenditureEvent[] = burns
    .filter((b) => !b.deletedAt)
    .map((b) => ({ timelineEventId: b.id, eventType: 'manual_calorie_burn' as const, occurredAt: b.occurredAt, energyKcal: -Math.abs(b.energyKcalMagnitude), label: b.label }));
  const expenditureEvents = [...tracked, ...burnEvents];
  const caloriesOutKcal = expenditureEvents.reduce((sum, e) => sum + Math.abs(e.energyKcal), 0);

  let totalProteinG: number | null = null;
  let totalCarbG: number | null = null;
  let totalFatG: number | null = null;
  for (const m of meals) {
    if (m.totalProteinG != null) totalProteinG = (totalProteinG ?? 0) + m.totalProteinG;
    if (m.totalCarbG != null) totalCarbG = (totalCarbG ?? 0) + m.totalCarbG;
    if (m.totalFatG != null) totalFatG = (totalFatG ?? 0) + m.totalFatG;
  }

  return {
    localDate,
    caloriesInKcal,
    caloriesOutKcal,
    netKcal: caloriesInKcal - caloriesOutKcal,
    expenditureEvents,
    totalProteinG,
    totalCarbG,
    totalFatG,
    mealCount: meals.length,
    waterMlTotal: water.reduce((sum, w) => sum + w.volumeMl, 0),
    isLocalFallback: true,
  };
}

/** Local-only aggregate for an arbitrary past day — the History-row data source (Food → History, design doc §CORE-08 "History"). Reuses the same reconstruction `useDailyNutrition`'s offline fallback uses, since History reads this device's own committed local rows either way (a day row need not hit the network — it's already-logged history). */
export async function computeDailyNutritionLocal(userId: string, localDate: string): Promise<DailyNutrition> {
  return localFallback(userId, localDate);
}

/** Distinct local dates with SOME logged activity (a meal, water, or a manual burn), most-recent-first — the History day-row list (cursor-free: Phase 3's history volume is small enough per day that a simple bounded DISTINCT scan is acceptable, mirroring `get_daily_energy_balance_v1`'s own "unbounded per-day reads acceptable at this scale" note). */
export async function listRecentLocalDatesWithActivity(userId: string, limit = 60): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ local_date: string }>(
    `SELECT local_date FROM (
       SELECT local_date FROM food_log_entries WHERE user_id = ? AND deleted_at IS NULL AND committed_at IS NOT NULL
       UNION
       SELECT local_date FROM water_intake_logs WHERE user_id = ? AND deleted_at IS NULL
       UNION
       SELECT local_date FROM manual_calorie_burn_logs WHERE user_id = ? AND deleted_at IS NULL
     ) ORDER BY local_date DESC LIMIT ?`,
    [userId, userId, userId, limit]
  );
  return rows.map((r) => r.local_date);
}

/**
 * CORE-08/11 daily energy ledger + macro breakdown, fed by
 * `get_daily_energy_balance_v1`/`get_daily_macros_v1` when online, and a
 * local-only reconstruction (this device's own unsynced writes) when
 * offline or the read fails — "the beam renders from local data; never a
 * full-screen wall if local data exists" (design doc §CORE-08 states).
 */
export function useDailyNutrition(userId: string | null, localDate: string) {
  const [data, setData] = useState<DailyNutrition | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);

    const online = await isOnline();
    if (!online) {
      setData(await localFallback(userId, localDate));
      setLoading(false);
      return;
    }

    try {
      const [balanceRes, macrosRes] = await Promise.all([
        supabase.rpc('get_daily_energy_balance_v1', { p_local_date: localDate }),
        supabase.rpc('get_daily_macros_v1', { p_local_date: localDate }),
      ]);
      const balanceBody = balanceRes.data as BalanceRpcResponse | null;
      const macrosBody = macrosRes.data as MacrosRpcResponse | null;
      if (balanceRes.error || macrosRes.error || balanceBody?.error || macrosBody?.error || !balanceBody?.data || !macrosBody?.data) {
        setData(await localFallback(userId, localDate));
        setLoadError(true);
        setLoading(false);
        return;
      }

      const events: ExpenditureEvent[] = balanceBody.data.expenditure_events.map((e) => ({
        timelineEventId: e.timeline_event_id,
        eventType: e.event_type as ExpenditureEvent['eventType'],
        occurredAt: e.occurred_at,
        energyKcal: e.energy_kcal,
        label: e.label,
      }));

      setData({
        localDate,
        caloriesInKcal: balanceBody.data.calories_in_kcal,
        caloriesOutKcal: balanceBody.data.calories_out_kcal,
        netKcal: balanceBody.data.net_kcal,
        expenditureEvents: events,
        totalProteinG: macrosBody.data.total_protein_g,
        totalCarbG: macrosBody.data.total_carb_g,
        totalFatG: macrosBody.data.total_fat_g,
        mealCount: macrosBody.data.meal_count,
        waterMlTotal: macrosBody.data.water_ml_total,
        isLocalFallback: false,
      });
    } catch {
      setData(await localFallback(userId, localDate));
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [userId, localDate]);

  useEffect(() => {
    // Synchronizes the day's aggregate with the server/local store on mount
    // and whenever the user/date changes — the documented legitimate effect
    // pattern this codebase uses throughout (see ProfileContext's own note).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return { data, loading, loadError, refresh };
}
