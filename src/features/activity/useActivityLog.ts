import { useCallback, useEffect, useMemo, useState } from 'react';

import { activityRepository, type ActivityPage } from '../../db/repositories/activityRepository';
import { activityTypesRepository } from '../../db/repositories/activityTypesRepository';
import { activityAchievementsRepository } from '../../db/repositories/activityAchievementsRepository';
import { weekKeyFor } from '../../lib/format';
import { runSync } from '../../sync/syncEngine';
import type { ActivityType, LocalActivity } from '../../db/types';

export type LoadState = 'loading' | 'empty' | 'ready' | 'error';

export type WeekGroup = {
  weekKey: string;
  totalDistanceM: number;
  activityCount: number;
  activities: LocalActivity[];
};

const PAGE_SIZE = 20;

/**
 * Own-activity timeline / Log (CORE-02 + CORE-05 — the same surface in
 * Phase 1, §12.1). Reads exclusively from the local `activities` table
 * (mobile-architecture-standards) and groups by week client-side for
 * `WeekHeader`.
 */
export function useActivityLog(userId: string | null) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activities, setActivities] = useState<LocalActivity[]>([]);
  const [activityTypes, setActivityTypes] = useState<Map<string, ActivityType>>(new Map());
  const [prByActivityId, setPrByActivityId] = useState<Set<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<ActivityPage['nextCursor']>(null);
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
      const [page, types] = await Promise.all([activityRepository.listPage(userId, null, PAGE_SIZE), activityTypesRepository.getAll()]);
      setActivities(page.items);
      setNextCursor(page.nextCursor);
      setActivityTypes(new Map(types.map((t) => [t.code, t])));

      const prSet = new Set<string>();
      for (const activity of page.items) {
        const achievements = await activityAchievementsRepository.getForActivity(activity.id);
        if (achievements.length > 0) prSet.add(activity.id);
      }
      setPrByActivityId(prSet);

      setLoadState(page.items.length === 0 ? 'empty' : 'ready');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your activity history.');
      setLoadState('error');
    }
  }, [userId]);

  useEffect(() => {
    // Synchronizes local list state with the local SQLite store on mount /
    // user change — same legitimate "sync with an external system" pattern
    // as ProfileContext's own effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInitial();
  }, [loadInitial]);

  const loadMore = useCallback(async () => {
    if (!userId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await activityRepository.listPage(userId, nextCursor, PAGE_SIZE);
      setActivities((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      const prSet = new Set(prByActivityId);
      for (const activity of page.items) {
        const achievements = await activityAchievementsRepository.getForActivity(activity.id);
        if (achievements.length > 0) prSet.add(activity.id);
      }
      setPrByActivityId(prSet);
    } finally {
      setLoadingMore(false);
    }
  }, [userId, nextCursor, loadingMore, prByActivityId]);

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

  const weeks = useMemo<WeekGroup[]>(() => {
    const map = new Map<string, WeekGroup>();
    for (const activity of activities) {
      const key = weekKeyFor(activity.occurredAt);
      const existing = map.get(key);
      if (existing) {
        existing.activities.push(activity);
        existing.activityCount += 1;
        existing.totalDistanceM += activity.distanceM ?? 0;
      } else {
        map.set(key, {
          weekKey: key,
          totalDistanceM: activity.distanceM ?? 0,
          activityCount: 1,
          activities: [activity],
        });
      }
    }
    return Array.from(map.values());
  }, [activities]);

  return {
    loadState,
    loadError,
    weeks,
    activityTypes,
    prByActivityId,
    hasMore: !!nextCursor,
    loadingMore,
    refreshing,
    loadMore,
    refresh,
    retrySync,
  };
}
