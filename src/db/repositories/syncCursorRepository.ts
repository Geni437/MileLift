import { getDb } from '../client';

/** Small generic incremental-pull cursor store — see schema.ts note. */
export const syncCursorRepository = {
  async get(userId: string, cursorKey: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM sync_cursors WHERE user_id = ? AND cursor_key = ?',
      [userId, cursorKey]
    );
    return row?.value ?? null;
  },

  async set(userId: string, cursorKey: string, value: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO sync_cursors (user_id, cursor_key, value) VALUES (?, ?, ?)
       ON CONFLICT(user_id, cursor_key) DO UPDATE SET value = excluded.value`,
      [userId, cursorKey, value]
    );
  },
};
