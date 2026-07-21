import { useCallback, useEffect, useMemo, useState } from 'react';

import { workoutSessionsRepository } from '../../db/repositories/workoutSessionsRepository';
import { strengthAchievementsRepository } from '../../db/repositories/strengthAchievementsRepository';
import { weekKeyFor } from '../../lib/format';
import { runSync } from '../../sync/syncEngine';
import type { LocalWorkoutSession } from '../../db/types';

export type LoadState = 'loading' | 'empty' | 'ready' | 'error';

export type WorkoutWeekGroup = {
  weekKey: string;
  totalVolumeKg: number;
  sessionCount: number;
  sessions: LocalWorkoutSession[];
};

const PAGE_SIZE = 20;

/** The Lift Log timeline (CORE-15's "Log" segment) — reads exclusively from the local `workout_sessions` mirror, grouped by week client-side, mirroring `useActivityLog`. */
export function useWorkoutLog(userId: string | null) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<LocalWorkoutSession[]>([]);
  const [prBySessionId, setPrBySessionId] = useState<Set<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<{ occurredAt: string; id: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadInitial = useCallback(async () => {
    if (!userId) {
      setLoadState('empty');
      return;
    }
    setLoadState('loading');
    setLoadError(null);
    try {
      const page = await workoutSessionsRepository.listPage(userId, null, PAGE_SIZE);
      setSessions(page.items);
      setNextCursor(page.nextCursor);
      const prSet = await strengthAchievementsRepository.getForSessions(page.items.map((s) => s.id));
      setPrBySessionId(prSet);
      setLoadState(page.items.length === 0 ? 'empty' : 'ready');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your training log.');
      setLoadState('error');
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInitial();
  }, [loadInitial]);

  const loadMore = useCallback(async () => {
    if (!userId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await workoutSessionsRepository.listPage(userId, nextCursor, PAGE_SIZE);
      setSessions((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      const newlyHasPr = await strengthAchievementsRepository.getForSessions(page.items.map((s) => s.id));
      setPrBySessionId((prev) => new Set([...prev, ...newlyHasPr]));
    } finally {
      setLoadingMore(false);
    }
  }, [userId, nextCursor, loadingMore]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await runSync('manual');
      await loadInitial();
    } finally {
      setRefreshing(false);
    }
  }, [loadInitial]);

  const retrySync = useCallback(() => {
    void runSync('manual').then(loadInitial);
  }, [loadInitial]);

  const weeks = useMemo<WorkoutWeekGroup[]>(() => {
    const map = new Map<string, WorkoutWeekGroup>();
    for (const session of sessions) {
      const key = weekKeyFor(session.occurredAt);
      const existing = map.get(key);
      if (existing) {
        existing.sessions.push(session);
        existing.sessionCount += 1;
        existing.totalVolumeKg += session.totalVolumeKg ?? 0;
      } else {
        map.set(key, { weekKey: key, totalVolumeKg: session.totalVolumeKg ?? 0, sessionCount: 1, sessions: [session] });
      }
    }
    return Array.from(map.values());
  }, [sessions]);

  return {
    loadState,
    loadError,
    weeks,
    prBySessionId,
    hasMore: !!nextCursor,
    loadingMore,
    refreshing,
    loadMore,
    refresh,
    retrySync,
  };
}
