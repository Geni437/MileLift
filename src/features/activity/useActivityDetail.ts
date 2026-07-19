import { useCallback, useEffect, useState } from 'react';

import { activityRepository } from '../../db/repositories/activityRepository';
import { activityRoutesRepository } from '../../db/repositories/activityRoutesRepository';
import { activityTypesRepository } from '../../db/repositories/activityTypesRepository';
import { activityAchievementsRepository } from '../../db/repositories/activityAchievementsRepository';
import { geoJsonLineStringToPoints, type Bounds } from '../../lib/geo';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { refreshKudosCount } from '../../sync/activitySync';
import { runSync } from '../../sync/syncEngine';
import type { ActivityType, LocalAchievement, LocalActivity, LocalActivityRoute } from '../../db/types';

export type DetailLoadState = 'loading' | 'ready' | 'not_found' | 'error';

export function useActivityDetail(activityId: string) {
  const { isOnline } = useNetworkStatus();
  const [loadState, setLoadState] = useState<DetailLoadState>('loading');
  const [activity, setActivity] = useState<LocalActivity | null>(null);
  const [activityType, setActivityType] = useState<ActivityType | null>(null);
  const [route, setRoute] = useState<LocalActivityRoute | null>(null);
  const [achievements, setAchievements] = useState<LocalAchievement[]>([]);
  const [kudosCount, setKudosCount] = useState<number>(0);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const found = await activityRepository.getLocal(activityId);
      if (!found || found.deletedAt) {
        setLoadState('not_found');
        return;
      }
      setActivity(found);
      const [type, routeRow, achievementRows] = await Promise.all([
        activityTypesRepository.getByCode(found.activityTypeCode),
        found.hasGpsRoute ? activityRoutesRepository.getByActivityId(activityId) : Promise.resolve(null),
        activityAchievementsRepository.getForActivity(activityId),
      ]);
      setActivityType(type);
      setRoute(routeRow);
      setAchievements(achievementRows);
      setKudosCount(found.kudosCount);
      setLoadState('ready');

      if (isOnline) {
        void refreshKudosCount(activityId).then((count) => {
          if (count != null) setKudosCount(count);
        });
      }
    } catch {
      setLoadState('error');
    }
  }, [activityId, isOnline]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const routePoints = route ? geoJsonLineStringToPoints(route.simplifiedGeojson) : [];
  const bounds: Bounds | null = route?.boundsJson ? (JSON.parse(route.boundsJson) as Bounds) : null;

  const deleteActivity = useCallback(async () => {
    if (!activity) return;
    await activityRepository.softDelete(activity.id);
    void runSync('post-write');
  }, [activity]);

  const editActivity = useCallback(
    async (fields: { title?: string | null; description?: string | null }) => {
      if (!activity) return;
      const merged = await activityRepository.upsertLocal(activity.id, activity.userId, {
        activityTypeCode: activity.activityTypeCode,
        activityTypeNameSnapshot: activity.activityTypeNameSnapshot,
        title: fields.title !== undefined ? fields.title : activity.title,
        description: fields.description !== undefined ? fields.description : activity.description,
        occurredAt: activity.occurredAt,
        localDate: activity.localDate,
        eventTimezone: activity.eventTimezone,
        durationSeconds: activity.durationSeconds,
        movingTimeSeconds: activity.movingTimeSeconds,
        distanceM: activity.distanceM,
        unitDistanceSnapshot: activity.unitDistanceSnapshot,
        elevationGainM: activity.elevationGainM,
        elevationLossM: activity.elevationLossM,
        averageSpeedMps: activity.averageSpeedMps,
        maxSpeedMps: activity.maxSpeedMps,
        averageHr: activity.averageHr,
        maxHr: activity.maxHr,
        hasGpsRoute: activity.hasGpsRoute,
        energyKcal: activity.energyKcal,
        caloriesSource: activity.caloriesSource,
        source: activity.source,
        visibility: activity.visibility,
        clientCreatedAt: activity.clientCreatedAt,
      });
      setActivity(merged);
      void runSync('post-write');
    },
    [activity]
  );

  return { loadState, activity, activityType, route, routePoints, bounds, achievements, kudosCount, deleteActivity, editActivity, refresh: load };
}
