import { getDb } from '../client';
import { supabase } from '../../lib/supabase';
import type { EquipmentType, ExerciseFieldFlags, LocalExercise, LocalExerciseMedia, MuscleGroup } from '../types';

type ExerciseRow = {
  id: string;
  slug: string;
  name: string;
  primary_muscle: string;
  secondary_muscles: string;
  equipment: string;
  mechanic: string | null;
  force_vector: string | null;
  is_distance_based: number;
  is_time_based: number;
  is_weighted: number;
  is_bodyweight: number;
  instructions: string | null;
  source: string;
  attribution: string | null;
  is_active: number;
};

type MediaRow = {
  id: string;
  exercise_id: string;
  media_type: string;
  url_or_object_path: string;
  is_primary: number;
  source: string;
  attribution: string | null;
  license: string | null;
  sort_order: number;
};

function toLocal(row: ExerciseRow): LocalExercise {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    primaryMuscle: row.primary_muscle as MuscleGroup,
    secondaryMuscles: row.secondary_muscles ? (row.secondary_muscles.split(',').filter(Boolean) as MuscleGroup[]) : [],
    equipment: row.equipment as EquipmentType,
    mechanic: row.mechanic as LocalExercise['mechanic'],
    forceVector: row.force_vector as LocalExercise['forceVector'],
    isDistanceBased: !!row.is_distance_based,
    isTimeBased: !!row.is_time_based,
    isWeighted: !!row.is_weighted,
    isBodyweight: !!row.is_bodyweight,
    instructions: row.instructions,
    source: row.source as LocalExercise['source'],
    attribution: row.attribution,
    isActive: !!row.is_active,
  };
}

function toLocalMedia(row: MediaRow): LocalExerciseMedia {
  return {
    id: row.id,
    exerciseId: row.exercise_id,
    mediaType: row.media_type as LocalExerciseMedia['mediaType'],
    urlOrObjectPath: row.url_or_object_path,
    isPrimary: !!row.is_primary,
    source: row.source as LocalExerciseMedia['source'],
    attribution: row.attribution,
    license: row.license,
    sortOrder: row.sort_order,
  };
}

export function exerciseFieldFlags(e: Pick<LocalExercise, 'isDistanceBased' | 'isTimeBased' | 'isWeighted' | 'isBodyweight'>): ExerciseFieldFlags {
  return { isDistanceBased: e.isDistanceBased, isTimeBased: e.isTimeBased, isWeighted: e.isWeighted, isBodyweight: e.isBodyweight };
}

const LIBRARY_PAGE_SIZE = 60;

/**
 * Read-only local cache of the global `exercises`/`exercise_media` library
 * (architecture §9.1, §9.6) — CORE-13 browse/search/filter and CORE-12
 * logging all read exclusively through here, so they work fully offline.
 * Refreshed opportunistically by `refreshExerciseLibraryIfStale` in
 * `src/sync/workoutSync.ts`, on its own cadence independent of the user's
 * timeline (§9.6).
 */
export const exercisesRepository = {
  async getById(id: string): Promise<LocalExercise | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ExerciseRow>('SELECT * FROM exercises WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async getMediaFor(exerciseId: string): Promise<LocalExerciseMedia[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<MediaRow>(
      'SELECT * FROM exercise_media WHERE exercise_id = ? ORDER BY sort_order ASC',
      [exerciseId]
    );
    return rows.map(toLocalMedia);
  },

  async getPrimaryMediaFor(exerciseIds: string[]): Promise<Map<string, LocalExerciseMedia>> {
    if (exerciseIds.length === 0) return new Map();
    const db = await getDb();
    const placeholders = exerciseIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<MediaRow>(
      `SELECT * FROM exercise_media WHERE exercise_id IN (${placeholders}) AND is_primary = 1`,
      exerciseIds
    );
    return new Map(rows.map((r) => [r.exercise_id, toLocalMedia(r)]));
  },

  /** Grouped-by-muscle browse (default, no search — design doc CORE-13). */
  async listGroupedByMuscle(): Promise<Map<MuscleGroup, LocalExercise[]>> {
    const db = await getDb();
    const rows = await db.getAllAsync<ExerciseRow>(
      'SELECT * FROM exercises WHERE is_active = 1 ORDER BY primary_muscle ASC, name ASC'
    );
    const grouped = new Map<MuscleGroup, LocalExercise[]>();
    for (const row of rows) {
      const local = toLocal(row);
      const list = grouped.get(local.primaryMuscle) ?? [];
      list.push(local);
      grouped.set(local.primaryMuscle, list);
    }
    return grouped;
  },

  /** Cursor-paginated name search + optional muscle/equipment filters (§5: "cursor-based, never unbounded"). */
  async search(params: {
    query: string;
    muscle: MuscleGroup | null;
    equipment: EquipmentType | null;
    cursorName: string | null;
    limit?: number;
  }): Promise<{ items: LocalExercise[]; nextCursor: string | null }> {
    const db = await getDb();
    const limit = params.limit ?? LIBRARY_PAGE_SIZE;
    const clauses: string[] = ['is_active = 1'];
    const args: (string | number)[] = [];
    if (params.query.trim()) {
      clauses.push('name LIKE ?');
      args.push(`%${params.query.trim()}%`);
    }
    if (params.muscle) {
      clauses.push('primary_muscle = ?');
      args.push(params.muscle);
    }
    if (params.equipment) {
      clauses.push('equipment = ?');
      args.push(params.equipment);
    }
    if (params.cursorName) {
      clauses.push('name > ?');
      args.push(params.cursorName);
    }
    const rows = await db.getAllAsync<ExerciseRow>(
      `SELECT * FROM exercises WHERE ${clauses.join(' AND ')} ORDER BY name ASC LIMIT ?`,
      [...args, limit + 1]
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toLocal);
    return { items, nextCursor: hasMore ? items[items.length - 1]!.name : null };
  },

  async hasAny(): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) as n FROM exercises');
    return (row?.n ?? 0) > 0;
  },

  /** Full-refresh pull of the library (§9.6: independent cadence from the user timeline; small-enough dataset per architecture §12 item 2 that a full refresh, not incremental, is acceptable). */
  async refreshFromServer(): Promise<void> {
    const { data: exercises, error: exercisesError } = await supabase.from('exercises').select('*');
    if (exercisesError || !exercises) return;
    const { data: media, error: mediaError } = await supabase.from('exercise_media').select('*');
    if (mediaError) return; // keep exercises fresh even if media fails; never worse than the previous cache

    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of exercises as ExerciseRow[]) {
        await db.runAsync(
          `INSERT INTO exercises (
             id, slug, name, primary_muscle, secondary_muscles, equipment, mechanic, force_vector,
             is_distance_based, is_time_based, is_weighted, is_bodyweight, instructions, source, attribution, is_active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug, name = excluded.name, primary_muscle = excluded.primary_muscle,
             secondary_muscles = excluded.secondary_muscles, equipment = excluded.equipment,
             mechanic = excluded.mechanic, force_vector = excluded.force_vector,
             is_distance_based = excluded.is_distance_based, is_time_based = excluded.is_time_based,
             is_weighted = excluded.is_weighted, is_bodyweight = excluded.is_bodyweight,
             instructions = excluded.instructions, source = excluded.source,
             attribution = excluded.attribution, is_active = excluded.is_active`,
          [
            row.id,
            row.slug,
            row.name,
            row.primary_muscle,
            Array.isArray((row as unknown as { secondary_muscles: string[] }).secondary_muscles)
              ? (row as unknown as { secondary_muscles: string[] }).secondary_muscles.join(',')
              : row.secondary_muscles ?? '',
            row.equipment,
            row.mechanic,
            row.force_vector,
            row.is_distance_based ? 1 : 0,
            row.is_time_based ? 1 : 0,
            row.is_weighted ? 1 : 0,
            row.is_bodyweight ? 1 : 0,
            row.instructions,
            row.source,
            row.attribution,
            row.is_active ? 1 : 0,
          ]
        );
      }

      if (media) {
        for (const row of media as MediaRow[]) {
          await db.runAsync(
            `INSERT INTO exercise_media (id, exercise_id, media_type, url_or_object_path, is_primary, source, attribution, license, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               media_type = excluded.media_type, url_or_object_path = excluded.url_or_object_path,
               is_primary = excluded.is_primary, source = excluded.source, attribution = excluded.attribution,
               license = excluded.license, sort_order = excluded.sort_order`,
            [
              row.id,
              row.exercise_id,
              row.media_type,
              row.url_or_object_path,
              row.is_primary ? 1 : 0,
              row.source,
              row.attribution,
              row.license,
              row.sort_order,
            ]
          );
        }
      }
    });
  },
};
