import { getDb } from '../client';
import type { FoodDataQuality, FoodMeasureBasis, FoodServing, FoodSource, LocalFoodCacheEntry } from '../types';

type Row = {
  food_id: string;
  source: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  basis: string;
  energy_kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  data_quality: string;
  attribution: string | null;
  servings_json: string;
  cached_at: string;
  last_used_at: string;
};

/** Bounded — evict least-recently-used rows beyond this after every cache write (§2.2/§2.4: "never a full-catalog mirror"). Generous enough to cover a real user's search/scan/log history without approaching any storage concern. */
const CACHE_CAP = 750;

function toLocal(row: Row): LocalFoodCacheEntry {
  let servings: FoodServing[] = [];
  try {
    servings = JSON.parse(row.servings_json) as FoodServing[];
  } catch {
    servings = [];
  }
  return {
    foodId: row.food_id,
    source: row.source as FoodSource,
    name: row.name,
    brand: row.brand,
    barcode: row.barcode,
    basis: row.basis as FoodMeasureBasis,
    energyKcal: row.energy_kcal,
    proteinG: row.protein_g,
    carbG: row.carb_g,
    fatG: row.fat_g,
    dataQuality: row.data_quality as FoodDataQuality,
    attribution: row.attribution,
    servings,
    cachedAt: row.cached_at,
    lastUsedAt: row.last_used_at,
  };
}

export type CacheableFood = {
  foodId: string;
  source: FoodSource;
  name: string;
  brand: string | null;
  barcode: string | null;
  basis: FoodMeasureBasis;
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  dataQuality: FoodDataQuality;
  attribution: string | null;
  servings: FoodServing[];
};

/**
 * Bounded local cache of resolved catalog foods (architecture §2.2/§2.4/§9)
 * — populated only from actual `search_foods_v1`/`resolve_barcode_v1`
 * responses (never a bulk `.select()` on `foods`), and read back for
 * offline search-of-recents, offline barcode resolution, and the CORE-10
 * offline saved-meal cached-macro fallback (design doc §CORE-10 "Decisions
 * D3"). Read-only from the server's point of view — never pushed by
 * `nutritionSync`.
 */
export const foodCacheRepository = {
  async getById(foodId: string): Promise<LocalFoodCacheEntry | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM food_cache WHERE food_id = ?', [foodId]);
    return row ? toLocal(row) : null;
  },

  /** Local-cache-first barcode lookup (§2.4 step 1) — offline-capable, fast. */
  async getByBarcode(barcode: string): Promise<LocalFoodCacheEntry | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM food_cache WHERE barcode = ? ORDER BY last_used_at DESC LIMIT 1', [barcode]);
    return row ? toLocal(row) : null;
  },

  /** Offline search fallback (§CORE-06 "Offline: search runs against the bounded local cache") — a simple substring match over the cache, never the full catalog. */
  async search(query: string, limit = 30): Promise<LocalFoodCacheEntry[]> {
    const db = await getDb();
    const trimmed = query.trim();
    if (!trimmed) return this.listRecentlyUsed(limit);
    const rows = await db.getAllAsync<Row>(
      `SELECT * FROM food_cache WHERE name LIKE ? OR brand LIKE ? ORDER BY last_used_at DESC LIMIT ?`,
      [`%${trimmed}%`, `%${trimmed}%`, limit]
    );
    return rows.map(toLocal);
  },

  async listRecentlyUsed(limit = 30): Promise<LocalFoodCacheEntry[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>('SELECT * FROM food_cache ORDER BY last_used_at DESC LIMIT ?', [limit]);
    return rows.map(toLocal);
  },

  /** Caches one or more resolved foods (a search page, a barcode hit) without marking them "used" — `markUsed` is the recency signal for the LRU eviction bound. */
  async cache(foods: CacheableFood[]): Promise<void> {
    if (foods.length === 0) return;
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      for (const food of foods) {
        const existing = await db.getFirstAsync<{ last_used_at: string; cached_at: string }>(
          'SELECT last_used_at, cached_at FROM food_cache WHERE food_id = ?',
          [food.foodId]
        );
        await db.runAsync(
          `INSERT INTO food_cache (food_id, source, name, brand, barcode, basis, energy_kcal, protein_g, carb_g, fat_g, data_quality, attribution, servings_json, cached_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(food_id) DO UPDATE SET
             source = excluded.source, name = excluded.name, brand = excluded.brand, barcode = excluded.barcode,
             basis = excluded.basis, energy_kcal = excluded.energy_kcal, protein_g = excluded.protein_g,
             carb_g = excluded.carb_g, fat_g = excluded.fat_g, data_quality = excluded.data_quality,
             attribution = excluded.attribution, servings_json = excluded.servings_json`,
          [
            food.foodId,
            food.source,
            food.name,
            food.brand,
            food.barcode,
            food.basis,
            food.energyKcal,
            food.proteinG,
            food.carbG,
            food.fatG,
            food.dataQuality,
            food.attribution,
            JSON.stringify(food.servings),
            existing?.cached_at ?? now,
            existing?.last_used_at ?? now,
          ]
        );
      }
      await evictBeyondCap(db);
    });
  },

  /** Bumps recency on select/log — the signal the LRU eviction bound uses (§2.4: "the top-N most-frequently-scanned/logged products"). */
  async markUsed(foodId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE food_cache SET last_used_at = ? WHERE food_id = ?', [new Date().toISOString(), foodId]);
  },
};

async function evictBeyondCap(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) as n FROM food_cache');
  const count = row?.n ?? 0;
  if (count <= CACHE_CAP) return;
  // Never evict a food still referenced by a locally-unsynced log item/saved
  // meal item — losing its cached macros would break the CORE-10 offline
  // cached-macro-fallback for a row that hasn't even synced yet.
  await db.runAsync(
    `DELETE FROM food_cache WHERE food_id IN (
       SELECT food_id FROM food_cache
       WHERE food_id NOT IN (SELECT food_id FROM food_log_items WHERE food_id IS NOT NULL)
         AND food_id NOT IN (SELECT food_id FROM saved_meal_items WHERE food_id IS NOT NULL)
       ORDER BY last_used_at ASC
       LIMIT ?
     )`,
    [count - CACHE_CAP]
  );
}
