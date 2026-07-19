import { getDb } from '../client';
import { bankMovingSecondsOnPause } from '../../features/activity/recordingClock';
import type { LocalRecordingSession, RecordingStatus } from '../types';

type RecordingSessionRow = {
  id: string;
  user_id: string;
  activity_type_code: string;
  status: string;
  started_at: string;
  last_resumed_at: string;
  accumulated_moving_seconds: number;
  location_declined: number;
  updated_at: string;
};

function toLocal(row: RecordingSessionRow): LocalRecordingSession {
  return {
    id: row.id,
    userId: row.user_id,
    activityTypeCode: row.activity_type_code,
    status: row.status as RecordingStatus,
    startedAt: row.started_at,
    lastResumedAt: row.last_resumed_at,
    accumulatedMovingSeconds: row.accumulated_moving_seconds,
    locationDeclined: !!row.location_declined,
    updatedAt: row.updated_at,
  };
}

/**
 * Local-only, in-progress-recording control state (architecture §9: layer-2
 * local domain state, never synced). Backs the CORE-01 crash-recovery resume
 * prompt: on relaunch, `getActiveForUser` tells the app whether to offer
 * "Resume or Discard?".
 */
export const recordingSessionRepository = {
  async getActiveForUser(userId: string): Promise<LocalRecordingSession | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<RecordingSessionRow>(
      'SELECT * FROM recording_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 1',
      [userId]
    );
    return row ? toLocal(row) : null;
  },

  async getById(id: string): Promise<LocalRecordingSession | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<RecordingSessionRow>('SELECT * FROM recording_sessions WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async start(id: string, userId: string, activityTypeCode: string, locationDeclined: boolean): Promise<LocalRecordingSession> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO recording_sessions (id, user_id, activity_type_code, status, started_at, last_resumed_at, accumulated_moving_seconds, location_declined, updated_at)
       VALUES (?, ?, ?, 'recording', ?, ?, 0, ?, ?)`,
      [id, userId, activityTypeCode, now, now, locationDeclined ? 1 : 0, now]
    );
    return (await this.getById(id))!;
  },

  async pause(id: string): Promise<LocalRecordingSession> {
    const db = await getDb();
    const existing = await this.getById(id);
    if (!existing) throw new Error(`recording_sessions: no session ${id} to pause`);
    const now = new Date();
    const banked = bankMovingSecondsOnPause(
      {
        status: existing.status,
        startedAt: existing.startedAt,
        lastResumedAt: existing.lastResumedAt,
        accumulatedMovingSeconds: existing.accumulatedMovingSeconds,
      },
      now
    );
    await db.runAsync(
      `UPDATE recording_sessions SET status = 'paused', accumulated_moving_seconds = ?, updated_at = ? WHERE id = ?`,
      [banked, now.toISOString(), id]
    );
    return (await this.getById(id))!;
  },

  async resume(id: string): Promise<LocalRecordingSession> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE recording_sessions SET status = 'recording', last_resumed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );
    return (await this.getById(id))!;
  },

  async setLocationDeclined(id: string, declined: boolean): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE recording_sessions SET location_declined = ?, updated_at = ? WHERE id = ?', [
      declined ? 1 : 0,
      new Date().toISOString(),
      id,
    ]);
  },

  async clear(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM recording_sessions WHERE id = ?', [id]);
  },
};
