import { getDb } from '../client';
import { generateUuidV4 } from '../../lib/uuid';
import type { LocalWearableLink, WearableLinkDirection, WearableProvider } from '../types';

type WearableLinkRow = {
  id: string;
  timeline_event_id: string;
  user_id: string;
  provider: string;
  direction: string;
  external_record_id: string;
  synced_at: string;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: WearableLinkRow): LocalWearableLink {
  return {
    id: row.id,
    timelineEventId: row.timeline_event_id,
    userId: row.user_id,
    provider: row.provider as WearableProvider,
    direction: row.direction as WearableLinkDirection,
    externalRecordId: row.external_record_id,
    syncedAt: row.synced_at,
    syncStatus: row.sync_status as LocalWearableLink['syncStatus'],
    lastSyncError: row.last_sync_error,
  };
}

/**
 * Provenance/dedup cache (mirrors `wearable_links`) — the loop-prevention
 * mechanism for CORE-03 two-way Health Connect sync (architecture §3.3).
 */
export const wearableLinksRepository = {
  /** True if we've already imported this external record (any direction check happens by caller passing 'inbound'). */
  async exists(provider: WearableProvider, direction: WearableLinkDirection, externalRecordId: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM wearable_links WHERE provider = ? AND direction = ? AND external_record_id = ?',
      [provider, direction, externalRecordId]
    );
    return (row?.n ?? 0) > 0;
  },

  /** All `outbound` external ids for this provider — used to skip re-importing MileLift's own write-backs (the actual loop-prevention check). */
  async getOutboundExternalIds(provider: WearableProvider): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ external_record_id: string }>(
      'SELECT external_record_id FROM wearable_links WHERE provider = ? AND direction = ?',
      [provider, 'outbound']
    );
    return new Set(rows.map((r) => r.external_record_id));
  },

  async hasOutboundForActivity(timelineEventId: string, provider: WearableProvider): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM wearable_links WHERE timeline_event_id = ? AND provider = ? AND direction = ?',
      [timelineEventId, provider, 'outbound']
    );
    return (row?.n ?? 0) > 0;
  },

  async recordLink(link: {
    timelineEventId: string;
    userId: string;
    provider: WearableProvider;
    direction: WearableLinkDirection;
    externalRecordId: string;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO wearable_links (id, timeline_event_id, user_id, provider, direction, external_record_id, synced_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
       ON CONFLICT DO NOTHING`,
      [generateUuidV4(), link.timelineEventId, link.userId, link.provider, link.direction, link.externalRecordId, now]
    );
  },

  async getUnsynced(): Promise<LocalWearableLink[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<WearableLinkRow>(`SELECT * FROM wearable_links WHERE sync_status IN ('pending', 'failed')`);
    return rows.map(toLocal);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE wearable_links SET sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE wearable_links SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [
      message,
      id,
    ]);
  },
};
