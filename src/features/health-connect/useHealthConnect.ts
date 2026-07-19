import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { healthConnectClient } from './healthConnectClient';
import { filterImportableRecords } from './loopPrevention';
import { generateUuidV4 } from '../../lib/uuid';
import { activityRepository } from '../../db/repositories/activityRepository';
import { activityTypesRepository } from '../../db/repositories/activityTypesRepository';
import { wearableLinksRepository } from '../../db/repositories/wearableLinksRepository';
import { healthConnectStateRepository } from '../../db/repositories/healthConnectStateRepository';
import { consentRepository } from '../../db/repositories/consentRepository';
import { runSync } from '../../sync/syncEngine';
import type { LocalHealthConnectState, UnitDistanceSnapshot } from '../../db/types';

export type HealthConnectConnectResult = { ok: true } | { ok: false; reason: 'not_android' | 'unavailable' | 'update_required' | 'permission_denied' };

const DEFAULT_IMPORT_LOOKBACK_DAYS = 30;

/**
 * CORE-03 orchestration: connect/sync/write-back for Android Health
 * Connect. Reads/writes ONLY through `healthConnectClient` (the native
 * boundary) and this app's own repositories — never a direct
 * `supabase.from(...)` call, consistent with the rest of the app
 * (mobile-architecture-standards).
 */
export function useHealthConnect(userId: string | null, unitDistance: UnitDistanceSnapshot) {
  const [state, setState] = useState<LocalHealthConnectState>({ userId: userId ?? '', connected: false, writeBackEnabled: false, lastSyncedAt: null, lastSyncError: null });
  const [syncing, setSyncing] = useState(false);
  const isAndroid = Platform.OS === 'android';

  const load = useCallback(async () => {
    if (!userId) return;
    const local = await healthConnectStateRepository.get(userId);
    setState(local);
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const connect = useCallback(async (): Promise<HealthConnectConnectResult> => {
    if (!userId || !isAndroid) return { ok: false, reason: 'not_android' };

    const availability = await healthConnectClient.checkAvailability();
    if (availability === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (availability === 'update_required') return { ok: false, reason: 'update_required' };

    await healthConnectClient.initialize();
    const granted = await healthConnectClient.requestPermissions(true);
    if (!granted) return { ok: false, reason: 'permission_denied' };

    await healthConnectStateRepository.setConnected(userId, true);
    await load();
    return { ok: true };
  }, [userId, isAndroid, load]);

  const setWriteBackEnabled = useCallback(
    async (enabled: boolean) => {
      if (!userId) return;
      await healthConnectStateRepository.setWriteBackEnabled(userId, enabled);
      await load();
    },
    [userId, load]
  );

  const syncNow = useCallback(async () => {
    if (!userId || !isAndroid || !state.connected) return;
    setSyncing(true);
    try {
      await importInbound(userId, unitDistance);
      if (state.writeBackEnabled) {
        await writeBackOutbound(userId);
      }
      await healthConnectStateRepository.markSyncResult(userId, { ok: true });
      void runSync('manual');
    } catch (err) {
      await healthConnectStateRepository.markSyncResult(userId, {
        ok: false,
        error: err instanceof Error ? err.message : 'Health Connect sync failed.',
      });
    } finally {
      setSyncing(false);
      await load();
    }
  }, [userId, isAndroid, state.connected, state.writeBackEnabled, unitDistance, load]);

  const platformGate = useMemo(() => (isAndroid ? 'android' : 'ios_unsupported'), [isAndroid]);

  return { state, syncing, platformGate, connect, syncNow, setWriteBackEnabled, refresh: load };
}

async function importInbound(userId: string, unitDistance: UnitDistanceSnapshot): Promise<void> {
  const sinceIso = new Date(Date.now() - DEFAULT_IMPORT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const sessions = await healthConnectClient.readSessions(sinceIso);

  const [outboundIds, hasHealthConsent, activityTypes] = await Promise.all([
    wearableLinksRepository.getOutboundExternalIds('health_connect'),
    consentRepository.getActive(userId, 'health').then((c) => !!c),
    activityTypesRepository.getAll(),
  ]);

  const alreadyImported = new Set<string>();
  for (const session of sessions) {
    const exists = await wearableLinksRepository.exists('health_connect', 'inbound', session.externalRecordId);
    if (exists) alreadyImported.add(session.externalRecordId);
  }

  const importable = filterImportableRecords(
    sessions.map((s) => ({ recordId: s.externalRecordId, externalDataOriginPackageName: s.dataOriginPackageName })),
    outboundIds,
    alreadyImported
  );
  const importableIds = new Set(importable.map((r) => r.recordId));
  const typeByCode = new Map(activityTypes.map((t) => [t.code, t]));

  for (const session of sessions) {
    if (!importableIds.has(session.externalRecordId)) continue;

    const type = typeByCode.get(session.activityTypeCode);
    const durationSeconds = Math.max(0, Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000));
    const id = generateUuidV4();

    await activityRepository.upsertLocal(id, userId, {
      activityTypeCode: session.activityTypeCode,
      activityTypeNameSnapshot: type?.displayName ?? session.activityTypeCode,
      title: session.title,
      description: null,
      occurredAt: session.startTime,
      localDate: session.startTime.slice(0, 10),
      eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationSeconds,
      movingTimeSeconds: durationSeconds,
      distanceM: session.distanceMeters,
      unitDistanceSnapshot: unitDistance,
      hasGpsRoute: false, // route ingestion from Health Connect is not implemented in this pass — flagged follow-up (see healthConnectClient.ts header)
      averageHr: hasHealthConsent ? session.averageHeartRateBpm : null,
      maxHr: hasHealthConsent ? session.maxHeartRateBpm : null,
      energyKcal: session.totalCalories != null ? -Math.round(session.totalCalories) : null,
      caloriesSource: session.totalCalories != null ? 'wearable' : 'none',
      source: 'wearable',
      visibility: 'private',
      clientCreatedAt: new Date().toISOString(),
    });

    await wearableLinksRepository.recordLink({
      timelineEventId: id,
      userId,
      provider: 'health_connect',
      direction: 'inbound',
      externalRecordId: session.externalRecordId,
    });
  }
}

async function writeBackOutbound(userId: string): Promise<void> {
  const candidates = await activityRepository.getManualConfirmedForUser(userId);
  for (const activity of candidates) {
    const alreadyLinked = await wearableLinksRepository.hasOutboundForActivity(activity.id, 'health_connect');
    if (alreadyLinked) continue;

    const endTime = new Date(new Date(activity.occurredAt).getTime() + activity.durationSeconds * 1000).toISOString();
    const recordId = await healthConnectClient.writeBackSession({
      activityTypeCode: activity.activityTypeCode,
      title: activity.title ?? activity.activityTypeNameSnapshot,
      startTime: activity.occurredAt,
      endTime,
      distanceMeters: activity.distanceM,
      totalCaloriesKcal: activity.energyKcal != null ? Math.abs(activity.energyKcal) : null,
    });

    await wearableLinksRepository.recordLink({
      timelineEventId: activity.id,
      userId,
      provider: 'health_connect',
      direction: 'outbound',
      externalRecordId: recordId,
    });
  }
}
