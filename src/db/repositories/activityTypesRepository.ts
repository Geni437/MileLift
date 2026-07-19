import { getDb } from '../client';
import { supabase } from '../../lib/supabase';
import type { ActivityCategory, ActivityType } from '../types';

type ActivityTypeRow = {
  code: string;
  display_name: string;
  category: string;
  is_distance_based: number;
  tracks_elevation: number;
  supports_gps: number;
  sort_order: number;
};

function toLocal(row: ActivityTypeRow): ActivityType {
  return {
    code: row.code,
    displayName: row.display_name,
    category: row.category as ActivityCategory,
    isDistanceBased: !!row.is_distance_based,
    tracksElevation: !!row.tracks_elevation,
    supportsGps: !!row.supports_gps,
    sortOrder: row.sort_order,
  };
}

/**
 * Reference-data cache for `activity_types` (architecture §1.1). Public,
 * read-mostly, global — pulled opportunistically and cached so the
 * recording/type-picker screens work fully offline after the first pull.
 * Never written by the client (service-role-write only, per §8).
 */
export const activityTypesRepository = {
  async getAll(): Promise<ActivityType[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ActivityTypeRow>('SELECT * FROM activity_types ORDER BY sort_order ASC');
    return rows.map(toLocal);
  },

  async getByCode(code: string): Promise<ActivityType | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ActivityTypeRow>('SELECT * FROM activity_types WHERE code = ?', [code]);
    return row ? toLocal(row) : null;
  },

  async hasAny(): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) as n FROM activity_types');
    return (row?.n ?? 0) > 0;
  },

  /** Pulls the full catalog and replaces the local cache. Safe to call opportunistically — cheap, small, rarely-changing table. */
  async refresh(): Promise<'ok' | 'offline_or_error'> {
    const { data, error } = await supabase.from('activity_types').select('*');
    if (error || !data) return 'offline_or_error';

    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of data as ActivityTypeRow[]) {
        await db.runAsync(
          `INSERT INTO activity_types (code, display_name, category, is_distance_based, tracks_elevation, supports_gps, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET
             display_name = excluded.display_name,
             category = excluded.category,
             is_distance_based = excluded.is_distance_based,
             tracks_elevation = excluded.tracks_elevation,
             supports_gps = excluded.supports_gps,
             sort_order = excluded.sort_order`,
          [
            row.code,
            row.display_name,
            row.category,
            row.is_distance_based ? 1 : 0,
            row.tracks_elevation ? 1 : 0,
            row.supports_gps ? 1 : 0,
            row.sort_order,
          ]
        );
      }
    });
    return 'ok';
  },
};
