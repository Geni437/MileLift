import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { healthConnectClient } from './healthConnectClient';
import { filterImportableRecords } from './loopPrevention';
import { generateUuidV4 } from '../../lib/uuid';
import { getDb } from '../../db/client';
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

    // The local activity insert and its `wearable_links` dedup row must land
    // together or not at all. Without this, a crash between the two steps
    // leaves no link row, so the next sync's `alreadyImported` dedup check
    // (above) finds nothing and re-imports the SAME Health Connect session
    // as a second local activity — worse, under a fresh random `id`, so
    // nothing downstream catches the duplicate either.
    const db = await getDb();
    await db.withTransactionAsync(async () => {
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
    });
  }
}

// Exported (not just called internally by `syncNow`) so the M2 consent-gate
// regression has direct test coverage — see
// src/__tests__/healthConnectWriteBackGate.test.ts — without standing up a
// full `useHealthConnect` hook + SQLite harness this codebase doesn't have
// elsewhere.
export async function writeBackOutbound(userId: string): Promise<void> {
  // M2 fix: write-back is entirely on-device (no server-side trigger can
  // backstop it, unlike stored HR data behind RLS), so the client is the
  // ONLY enforcement point for "don't write health data back out once
  // consent is revoked." Re-check the active `health` consent row on every
  // sync — not just at initial connect time (HealthConnectSection.tsx) —
  // since consent can be revoked at any time independent of
  // `writeBackEnabled` (see ConsentContext.revoke, which now also forces
  // `writeBackEnabled` off, but this check exists so a revoke that hasn't
  // reached that code path yet, e.g. a server-side reconcile, still blocks
  // the write).
  const hasHealthConsent = await consentRepository.getActive(userId, 'health');
  if (!hasHealthConsent) return;

  const candidates = await activityRepository.getManualConfirmedForUser(userId);
  const db = await getDb();
  for (const activity of candidates) {
    const alreadyLinked = await wearableLinksRepository.hasOutboundForActivity(activity.id, 'health_connect');
    if (alreadyLinked) continue;

    const endTime = new Date(new Date(activity.occurredAt).getTime() + activity.durationSeconds * 1000).toISOString();
    // `clientRecordId` (derived from this app's own activity id) makes the
    // Health Connect write itself idempotent: if the app crashes/is killed
    // after this call succeeds but before `recordLink` below commits, the
    // NEXT sync's `alreadyLinked` check (above) still finds nothing and
    // retries this write — but because it reuses the same `clientRecordId`,
    // Health Connect updates the existing record in place instead of
    // inserting a duplicate. Unlike `importInbound`'s two local writes, this
    // gap spans one local commit and one external platform call, which a
    // local SQLite transaction alone can't straddle — this is the actual
    // fix for the "write is not idempotent" bug (see healthConnectClient.ts).
    const recordId = await healthConnectClient.writeBackSession({
      activityTypeCode: activity.activityTypeCode,
      title: activity.title ?? activity.activityTypeNameSnapshot,
      startTime: activity.occurredAt,
      endTime,
      distanceMeters: activity.distanceM,
      totalCaloriesKcal: activity.energyKcal != null ? Math.abs(activity.energyKcal) : null,
      clientRecordId: activity.id,
    });

    // Single local write, so this is already atomic — wrapped for
    // consistency with importInbound's create+link pair and so any future
    // addition of a second local write here (e.g. a write-back status
    // column) doesn't silently reintroduce the partial-write gap.
    await db.withTransactionAsync(async () => {
      await wearableLinksRepository.recordLink({
        timelineEventId: activity.id,
        userId,
        provider: 'health_connect',
        direction: 'outbound',
        externalRecordId: recordId,
      });
    });
  }
}
