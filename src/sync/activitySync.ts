import { supabase } from '../lib/supabase';
import { getDb } from '../db/client';
import { uploadRawTrack } from '../lib/activityTrackStorage';
import { activityRepository } from '../db/repositories/activityRepository';
import type { ServerActivityRow } from '../db/repositories/activityRepository';
import { activityRoutesRepository } from '../db/repositories/activityRoutesRepository';
import { routePointsRepository } from '../db/repositories/routePointsRepository';
import { personalRecordsRepository } from '../db/repositories/personalRecordsRepository';
import { activityAchievementsRepository } from '../db/repositories/activityAchievementsRepository';
import { syncCursorRepository } from '../db/repositories/syncCursorRepository';
import { activityTypesRepository } from '../db/repositories/activityTypesRepository';
import { diffAchievements } from '../features/activity/prEngine';
import type { LocalActivity, PrMetric, AchievementRank } from '../db/types';

/**
 * Push/pull for `activities` (the merged spine+detail mirror) and its
 * satellite caches (`personal_records`, `activity_achievements`). Wired into
 * `src/sync/syncEngine.ts`'s `runSync`, same opportunistic triggers as
 * Phase 0's profile/consent sync (mobile-architecture-standards: sync
 * opportunistically, not a persistent-connection assumption).
 *
 * Save/edit ALWAYS goes through the `save_activity_v1` RPC, never a plain
 * PostgREST upsert (architecture §5: multi-table transactional write + PR
 * detection). Deletion is the one exception — a soft-delete tombstone is a
 * direct `timeline_events.deleted_at` UPDATE via PostgREST, matching the
 * Phase 0 profiles/timeline_events soft-delete convention (§7/§8: "no
 * client DELETE ... soft-delete via UPDATE").
 */

const ACTIVITIES_CURSOR_KEY = 'activities_updated_at';
const PULL_PAGE_SIZE = 200;

type SaveActivityRpcResponse = {
  data?: {
    id: string;
    activity_type_code: string;
    occurred_at: string;
    local_date: string;
    duration_seconds: number;
    moving_time_seconds: number | null;
    distance_m: number | null;
    has_gps_route: boolean;
    energy_kcal: number | null;
    achievements: { metric: PrMetric; value: number; rank?: AchievementRank }[];
  };
  error?: { code: string; message: string; field: string | null };
};

export async function pushActivities(userId: string): Promise<void> {
  const unsynced = await activityRepository.getUnsynced(userId);
  for (const activity of unsynced) {
    if (activity.deletedAt) {
      await pushTombstone(activity);
    } else {
      await pushSave(activity);
    }
  }
}

async function pushTombstone(activity: LocalActivity): Promise<void> {
  const wasConfirmed = await activityRepository.wasServerConfirmed(activity.id);
  if (!wasConfirmed) {
    // Recorded and deleted entirely offline — the server never saw it.
    // Nothing to push; just drop the local row.
    await activityRepository.purgeLocalOnly(activity.id);
    return;
  }

  const { error } = await supabase.from('timeline_events').update({ deleted_at: activity.deletedAt }).eq('id', activity.id);
  if (error) {
    await activityRepository.markFailed(activity.id, error.message);
    return;
  }
  await activityRepository.markDeleteSynced(activity.id);
}

async function pushSave(activity: LocalActivity): Promise<void> {
  const rpcParams: Record<string, unknown> = {
    p_id: activity.id,
    p_activity_type_code: activity.activityTypeCode,
    p_occurred_at: activity.occurredAt,
    p_local_date: activity.localDate,
    p_event_timezone: activity.eventTimezone,
    p_duration_seconds: activity.durationSeconds,
    p_source: activity.source,
    p_visibility: activity.visibility,
    p_energy_kcal: activity.energyKcal,
    p_title: activity.title,
    p_description: activity.description,
    p_distance_m: activity.distanceM,
    p_unit_distance_snapshot: activity.unitDistanceSnapshot,
    p_moving_time_seconds: activity.movingTimeSeconds,
    p_elevation_gain_m: activity.elevationGainM,
    p_elevation_loss_m: activity.elevationLossM,
    p_average_speed_mps: activity.averageSpeedMps,
    p_max_speed_mps: activity.maxSpeedMps,
    p_average_hr: activity.averageHr,
    p_max_hr: activity.maxHr,
    p_calories_source: activity.caloriesSource,
    p_client_created_at: activity.clientCreatedAt,
  };

  if (activity.hasGpsRoute) {
    const route = await activityRoutesRepository.getByActivityId(activity.id);
    if (!route) {
      // A GPS activity that lost its local route row is a real data-
      // integrity gap, not something to silently paper over by saving
      // without a route (that would permanently disagree with has_gps_route).
      await activityRepository.markFailed(activity.id, 'Route data missing locally — cannot sync a GPS activity without its route.');
      return;
    }

    if (route.rawTrackUploadStatus !== 'uploaded') {
      const points = await routePointsRepository.getAll(activity.id);
      if (points.length === 0) {
        await activityRepository.markFailed(
          activity.id,
          'Raw track upload never completed and the recorded points are no longer available locally.'
        );
        return;
      }
      const uploadResult = await uploadRawTrack(
        activity.userId,
        activity.id,
        points.map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          elevationM: p.elevationM,
          accuracyM: p.accuracyM,
          recordedAt: p.recordedAt,
        }))
      );
      if (!uploadResult.ok) {
        await activityRoutesRepository.markUploadFailed(activity.id);
        await activityRepository.markFailed(activity.id, `Track upload failed: ${uploadResult.error}`);
        return; // never report "synced" on a partial failure (architecture §10)
      }
      await activityRoutesRepository.markUploaded(activity.id, uploadResult.checksum);
    }

    const confirmedRoute = await activityRoutesRepository.getByActivityId(activity.id);
    if (confirmedRoute) {
      rpcParams.p_route_geojson = JSON.parse(confirmedRoute.simplifiedGeojson);
      rpcParams.p_raw_track_object_path = confirmedRoute.rawTrackObjectPath;
      rpcParams.p_raw_track_checksum = confirmedRoute.rawTrackChecksum;
      rpcParams.p_raw_point_count = confirmedRoute.rawPointCount;
      rpcParams.p_simplified_point_count = confirmedRoute.simplifiedPointCount;
    }
  }

  const { data, error } = await supabase.rpc('save_activity_v1', rpcParams);

  if (error) {
    // Transport-level failure (network, auth, PostgREST-level rejection) —
    // distinct from the RPC's own `{ error }` envelope, per
    // docs/api/save-activity-v1.md §1 ("branch on the presence of `error`
    // in the body, not on HTTP status" — this branch is the rarer
    // transport-level case that shape doesn't cover).
    await activityRepository.markFailed(activity.id, error.message);
    return;
  }

  const body = data as SaveActivityRpcResponse | null;
  if (body?.error) {
    await activityRepository.markFailed(activity.id, `${body.error.code}: ${body.error.message}`);
    return;
  }
  const result = body?.data;
  if (!result) {
    await activityRepository.markFailed(activity.id, 'Empty response from save_activity_v1.');
    return;
  }

  await activityRepository.markSynced(activity.id, {
    distanceM: result.distance_m,
    durationSeconds: result.duration_seconds,
    movingTimeSeconds: result.moving_time_seconds,
    hasGpsRoute: result.has_gps_route,
    energyKcal: result.energy_kcal,
  });

  // The server now durably has the track — the local in-progress buffer
  // (already superseded by the finished activity_routes row) can go.
  await routePointsRepository.clear(activity.id);

  await reconcilePrs(activity, result.achievements ?? []);
}

/**
 * Optimistic-then-reconciled PR celebration (design doc CORE-04): compares
 * what we celebrated locally at finish-time against the RPC's authoritative
 * `achievements` array and corrects any disagreement without a second
 * celebratory interruption.
 */
async function reconcilePrs(
  activity: LocalActivity,
  serverAchievements: { metric: PrMetric; value: number; rank?: AchievementRank }[]
): Promise<void> {
  const localRows = await activityAchievementsRepository.getForActivity(activity.id);
  const optimisticMetrics = localRows.filter((r) => r.isOptimistic).map((r) => r.metric);
  const serverMetrics = serverAchievements.map((a) => a.metric);
  const { retracted } = diffAchievements(optimisticMetrics, serverMetrics);

  // Every server-confirmed metric (whether we'd optimistically guessed it
  // or not — e.g. first sync ever, no local cache yet) becomes the
  // confirmed local record.
  for (const server of serverAchievements) {
    await activityAchievementsRepository.confirm(activity.id, server.metric, server.value, server.rank ?? 'pr');
    await personalRecordsRepository.confirm(
      activity.userId,
      activity.activityTypeCode,
      server.metric,
      server.value,
      activity.unitDistanceSnapshot,
      activity.id,
      activity.occurredAt
    );
  }

  // Anything we celebrated locally that the server did NOT confirm: quietly
  // correct it — remove the badge and re-pull the true current record for
  // that metric.
  for (const metric of retracted) {
    await activityAchievementsRepository.retract(activity.id, metric);

    const { data } = await supabase
      .from('personal_records')
      .select('*')
      .eq('user_id', activity.userId)
      .eq('activity_type_code', activity.activityTypeCode)
      .eq('metric', metric)
      .maybeSingle();

    if (data) {
      await personalRecordsRepository.reconcileFromServerRow(
        {
          userId: data.user_id,
          activityTypeCode: data.activity_type_code,
          metric: data.metric,
          value: data.value,
          unitSnapshot: data.unit_snapshot,
          timelineEventId: data.timeline_event_id,
          achievedAt: data.achieved_at,
          previousValue: data.previous_value,
        },
        { userId: activity.userId, activityTypeCode: activity.activityTypeCode, metric }
      );
    } else {
      await personalRecordsRepository.reconcileFromServerRow(null, {
        userId: activity.userId,
        activityTypeCode: activity.activityTypeCode,
        metric,
      });
    }
  }
}

/**
 * Incremental pull of activity metadata (spine + detail fields), cursor on
 * `activity_details.updated_at` (both rows are written in the same
 * `save_activity_v1` transaction, so their `updated_at` values move
 * together). A local row with an unsynced edit/delete is left untouched
 * (activityRepository.reconcileFromServer honors that).
 *
 * KNOWN GAP (flagged, not silently skipped): this does not re-hydrate
 * `activity_routes` for an activity created on a DIFFERENT device (or after
 * a reinstall) — `simplified_path` is a raw PostGIS geometry column and
 * PostgREST cannot serialize it to JSON without a computed/generated
 * GeoJSON column or a read RPC, neither of which exists yet in the current
 * migrations. On the device that actually recorded/finished the activity,
 * the local route is already correct and this gap never surfaces (the
 * design doc's "map always draws from the local simplified path" holds).
 * Follow-up: `db-engineer` adds e.g. `simplified_geojson text generated
 * always as (extensions.st_asgeojson(simplified_path)) stored` (or an
 * equivalent read RPC) so a genuinely different device can pull the route.
 */
export async function pullActivities(userId: string): Promise<void> {
  const cursor = (await syncCursorRepository.get(userId, ACTIVITIES_CURSOR_KEY)) ?? '1970-01-01T00:00:00.000Z';

  const { data, error } = await supabase
    .from('activity_details')
    .select('*, timeline_events(*)')
    .eq('user_id', userId)
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(PULL_PAGE_SIZE);

  if (error || !data) return;

  type EmbeddedRow = Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null };

  const merged = (data as EmbeddedRow[])
    .map((row) => {
      const te = Array.isArray(row.timeline_events) ? row.timeline_events[0] : row.timeline_events;
      if (!te) return null;
      return {
        id: te.id,
        user_id: row.user_id,
        activity_type_code: row.activity_type_code,
        activity_type_name_snapshot: row.activity_type_name_snapshot,
        title: row.title,
        description: row.description,
        occurred_at: te.occurred_at,
        local_date: te.local_date,
        event_timezone: te.event_timezone,
        duration_seconds: te.duration_seconds,
        moving_time_seconds: row.moving_time_seconds,
        distance_m: row.distance_m,
        unit_distance_snapshot: row.unit_distance_snapshot,
        elevation_gain_m: row.elevation_gain_m,
        elevation_loss_m: row.elevation_loss_m,
        average_speed_mps: row.average_speed_mps,
        max_speed_mps: row.max_speed_mps,
        average_hr: row.average_hr,
        max_hr: row.max_hr,
        has_gps_route: row.has_gps_route,
        energy_kcal: te.energy_kcal,
        calories_source: row.calories_source,
        source: te.source,
        visibility: te.visibility,
        client_created_at: te.client_created_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: te.deleted_at,
      } as unknown as ServerActivityRow;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (merged.length > 0) {
    await activityRepository.reconcileFromServer(merged);
    const last = merged[merged.length - 1];
    if (typeof last.updated_at === 'string') {
      await syncCursorRepository.set(userId, ACTIVITIES_CURSOR_KEY, last.updated_at);
    }
  }
}

export async function pullPersonalRecords(userId: string): Promise<void> {
  const { data, error } = await supabase.from('personal_records').select('*').eq('user_id', userId);
  if (error || !data) return;
  await personalRecordsRepository.reconcileAllFromServer(data);
}

export async function pullActivityAchievements(userId: string): Promise<void> {
  const { data, error } = await supabase.from('activity_achievements').select('*').eq('user_id', userId);
  if (error || !data) return;
  await activityAchievementsRepository.reconcileAllFromServer(data);
}

export async function refreshActivityTypesIfNeeded(): Promise<void> {
  const hasAny = await activityTypesRepository.hasAny();
  if (!hasAny) {
    await activityTypesRepository.refresh();
  }
}

/** Fetches (and caches, best-effort) the kudos count for one activity — the reserved, non-interactive detail-screen spot (design doc CORE-02 point 8). */
export async function refreshKudosCount(activityId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('kudos')
    .select('id', { count: 'exact', head: true })
    .eq('timeline_event_id', activityId);
  if (error || count == null) return null;

  const db = await getDb();
  await db.runAsync('UPDATE activities SET kudos_count = ?, kudos_count_fetched_at = ? WHERE id = ?', [
    count,
    new Date().toISOString(),
    activityId,
  ]);
  return count;
}
