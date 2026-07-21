import { getDb } from '../client';
import type { LocalProgressPhoto, LocalProgressPhotoImage, PhotoPose, PhotoUploadStatus, SyncStatus } from '../types';

type Row = {
  id: string;
  user_id: string;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ImageRow = { id: string; timeline_event_id: string; pose: string; local_uri: string | null; object_path: string | null; checksum: string | null; upload_status: string };

async function loadImages(timelineEventId: string): Promise<LocalProgressPhotoImage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ImageRow>('SELECT * FROM progress_photo_images WHERE timeline_event_id = ?', [timelineEventId]);
  return rows.map((r) => ({
    id: r.id,
    timelineEventId: r.timeline_event_id,
    pose: r.pose as PhotoPose,
    localUri: r.local_uri,
    objectPath: r.object_path,
    checksum: r.checksum,
    uploadStatus: r.upload_status as PhotoUploadStatus,
  }));
}

async function toLocal(row: Row): Promise<LocalProgressPhoto> {
  return {
    id: row.id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    notes: row.notes,
    images: await loadImages(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/** CORE-16 progress photos — body_image-consent-gated, upload-then-metadata ordering (§5/§10: never "saved" on a partial upload). */
export const progressPhotosRepository = {
  async listForUser(userId: string, limit = 60): Promise<LocalProgressPhoto[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>('SELECT * FROM progress_photos WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT ?', [userId, limit]);
    const results: LocalProgressPhoto[] = [];
    for (const row of rows) results.push(await toLocal(row));
    return results;
  },

  async getById(id: string): Promise<LocalProgressPhoto | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM progress_photos WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async create(id: string, userId: string, fields: { occurredAt: string; localDate: string; eventTimezone: string; notes: string | null }): Promise<LocalProgressPhoto> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO progress_photos (id, user_id, occurred_at, local_date, event_timezone, notes, created_at, updated_at, server_confirmed, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [id, userId, fields.occurredAt, fields.localDate, fields.eventTimezone, fields.notes, now, now]
    );
    return (await this.getById(id))!;
  },

  async addImage(id: string, timelineEventId: string, pose: PhotoPose, localUri: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO progress_photo_images (id, timeline_event_id, pose, local_uri, upload_status) VALUES (?, ?, ?, ?, 'pending')`,
      [id, timelineEventId, pose, localUri]
    );
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE progress_photos SET sync_status = 'pending', updated_at = ? WHERE id = ?`, [now, timelineEventId]);
  },

  async markImageUploaded(imageId: string, objectPath: string, checksum: string | null): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE progress_photo_images SET object_path = ?, checksum = ?, upload_status = 'uploaded' WHERE id = ?`, [objectPath, checksum, imageId]);
  },

  async markImageFailed(imageId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE progress_photo_images SET upload_status = 'failed' WHERE id = ?`, [imageId]);
  },

  async getPendingImages(timelineEventId: string): Promise<LocalProgressPhotoImage[]> {
    const all = await loadImages(timelineEventId);
    return all.filter((i) => i.uploadStatus !== 'uploaded');
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE progress_photos SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM progress_photos WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM progress_photo_images WHERE timeline_event_id = ?', [id]);
      await db.runAsync('DELETE FROM progress_photos WHERE id = ? AND server_confirmed = 0', [id]);
    });
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE progress_photos SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE progress_photos SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalProgressPhoto[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(`SELECT * FROM progress_photos WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    const results: LocalProgressPhoto[] = [];
    for (const row of rows) results.push(await toLocal(row));
    return results;
  },
};
