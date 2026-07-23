/**
 * Regression test for a real bug found during Phase 3 code review — the same
 * shape as `foodLogEditAfterSyncBug.test.ts`'s already-fixed bug, but in the
 * sibling `saved_meals`/`saved_meal_items` pair, which was missed in that
 * first pass.
 *
 * `pushSavedMeals` (src/sync/nutritionSync.ts) only ever revisits a meal via
 * `savedMealsRepository.getUnsynced(userId)` — `sync_status IN ('pending',
 * 'failed')`. Editing/adding/removing an item on an already-synced meal (via
 * `app/(app)/saved-meals/[id].tsx`, a shipped, wired screen) only ever set
 * the ITEM's own `sync_status`, never touching the PARENT meal's — so once a
 * meal reached `sync_status = 'synced'`, `pushSavedMeals`'s outer loop would
 * never revisit it again, and `getPendingItemDeletes`/`getUnsyncedItems`
 * (both scoped to that meal's id) were simply never called. The item change
 * was silently never pushed to the server, indefinitely.
 *
 * Fixed by `markMealDirtyIfSynced` (`src/db/repositories/savedMealsRepository.ts`),
 * called from both `upsertItem` and `removeItem` after the item write —
 * re-enqueues an already-synced meal (`sync_status -> 'pending'`) so the next
 * sync pass revisits it and its items.
 */

import { savedMealsRepository } from '../db/repositories/savedMealsRepository';

type MealRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  meal_type: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ItemRow = {
  id: string;
  saved_meal_id: string;
  user_id: string;
  food_id: string | null;
  custom_food_id: string | null;
  food_name_snapshot_local: string;
  serving_label: string;
  serving_g_or_ml: number;
  quantity: number;
  sort_order: number;
  deleted_locally: number;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

/**
 * A minimal in-memory stand-in for the `expo-sqlite` handle, implementing
 * ONLY the exact literal query shapes `savedMealsRepository` issues along
 * the `upsertItem`/`removeItem` -> `getUnsynced` path (verified by reading
 * `src/db/repositories/savedMealsRepository.ts` directly) — the same
 * white-box repository test class as `foodLogEditAfterSyncBug.test.ts`.
 */
function mockCreateFakeDb(meals: MealRow[], items: ItemRow[]) {
  return {
    async getFirstAsync(sql: string, params: unknown[]) {
      if (sql.includes('FROM saved_meal_items WHERE id = ?')) {
        return items.find((i) => i.id === params[0]) ?? null;
      }
      if (sql.includes('FROM saved_meals WHERE id = ?')) {
        return meals.find((m) => m.id === params[0]) ?? null;
      }
      throw new Error(`Unhandled getFirstAsync: ${sql}`);
    },
    async getAllAsync(sql: string, params: unknown[]) {
      if (sql.includes(`sync_status IN ('pending', 'failed')`) && sql.includes('FROM saved_meals')) {
        return meals.filter((m) => m.user_id === params[0] && (m.sync_status === 'pending' || m.sync_status === 'failed'));
      }
      throw new Error(`Unhandled getAllAsync: ${sql}`);
    },
    async runAsync(sql: string, params: unknown[]) {
      if (sql.startsWith('INSERT INTO saved_meal_items') && sql.includes('ON CONFLICT(id) DO UPDATE')) {
        const [id, savedMealId, userId, foodId, customFoodId, foodNameSnapshotLocal, servingLabel, servingGOrMl, quantity, sortOrder] = params as [
          string, string, string, string | null, string | null, string, string, number, number, number,
        ];
        const existing = items.find((i) => i.id === id);
        if (existing) {
          existing.serving_label = servingLabel;
          existing.serving_g_or_ml = servingGOrMl;
          existing.quantity = quantity;
          existing.sort_order = sortOrder;
          existing.food_name_snapshot_local = foodNameSnapshotLocal;
          existing.sync_status = 'pending';
        } else {
          items.push({
            id,
            saved_meal_id: savedMealId,
            user_id: userId,
            food_id: foodId,
            custom_food_id: customFoodId,
            food_name_snapshot_local: foodNameSnapshotLocal,
            serving_label: servingLabel,
            serving_g_or_ml: servingGOrMl,
            quantity,
            sort_order: sortOrder,
            deleted_locally: 0,
            server_confirmed: 0,
            sync_status: 'pending',
            last_sync_error: null,
          });
        }
        return;
      }
      if (sql.includes('UPDATE saved_meal_items SET deleted_locally = 1')) {
        const item = items.find((i) => i.id === params[0]);
        if (item) {
          item.deleted_locally = 1;
          item.sync_status = 'pending';
        }
        return;
      }
      if (sql.includes('DELETE FROM saved_meal_items WHERE id = ?')) {
        const idx = items.findIndex((i) => i.id === params[0]);
        if (idx >= 0) items.splice(idx, 1);
        return;
      }
      // markMealDirtyIfSynced's re-enqueue write — matched by its precise
      // WHERE clause so it can't be confused with any other saved_meals
      // UPDATE (name/description edits, softDelete) that also touch
      // sync_status = 'pending'.
      if (sql === `UPDATE saved_meals SET sync_status = 'pending', last_sync_error = NULL WHERE id = ? AND sync_status = 'synced'`) {
        const meal = meals.find((m) => m.id === params[0]);
        if (meal && meal.sync_status === 'synced') {
          meal.sync_status = 'pending';
          meal.last_sync_error = null;
        }
        return;
      }
      throw new Error(`Unhandled runAsync: ${sql}`);
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      await fn();
    },
  };
}

let mockFakeMeals: MealRow[];
let mockFakeItems: ItemRow[];

jest.mock('../db/client', () => ({
  getDb: jest.fn(async () => mockCreateFakeDb(mockFakeMeals, mockFakeItems)),
}));

const MEAL_ID = 'saved-meal-already-synced-1';
const USER_ID = 'user-1';
const EXISTING_ITEM_ID = 'saved-meal-item-already-synced-1';

function freshSyncedMeal(): MealRow {
  return {
    id: MEAL_ID,
    user_id: USER_ID,
    name: 'Breakfast',
    description: null,
    meal_type: 'breakfast',
    deleted_at: null,
    created_at: '2026-07-23T08:00:00.000Z',
    updated_at: '2026-07-23T08:00:00.000Z',
    server_confirmed: 1,
    sync_status: 'synced',
    last_sync_error: null,
  };
}

describe('savedMealsRepository item edits on an ALREADY-SYNCED meal (app/(app)/saved-meals/[id].tsx)', () => {
  beforeEach(() => {
    mockFakeMeals = [freshSyncedMeal()];
    mockFakeItems = [
      {
        id: EXISTING_ITEM_ID,
        saved_meal_id: MEAL_ID,
        user_id: USER_ID,
        food_id: 'food-1',
        custom_food_id: null,
        food_name_snapshot_local: 'Oats',
        serving_label: '1 bowl',
        serving_g_or_ml: 80,
        quantity: 1,
        sort_order: 0,
        deleted_locally: 0,
        server_confirmed: 1,
        sync_status: 'synced',
        last_sync_error: null,
      },
    ];
  });

  it('re-enqueues the meal for push (sync_status -> pending) after adding an item to an already-synced meal', async () => {
    await savedMealsRepository.upsertItem('new-item-1', MEAL_ID, USER_ID, {
      foodId: 'food-2',
      customFoodId: null,
      foodNameSnapshotLocal: 'Banana',
      servingLabel: '1 medium',
      servingGOrMl: 118,
      quantity: 1,
      sortOrder: 1,
    });

    const meal = await savedMealsRepository.getById(MEAL_ID);
    expect(meal?.syncStatus).toBe('pending');
  });

  it('re-enqueues the meal for push after removing an item from an already-synced meal', async () => {
    await savedMealsRepository.removeItem(EXISTING_ITEM_ID);

    const meal = await savedMealsRepository.getById(MEAL_ID);
    expect(meal?.syncStatus).toBe('pending');
  });

  it('is returned by getUnsynced() so the next sync push actually sends the item change to the server', async () => {
    await savedMealsRepository.removeItem(EXISTING_ITEM_ID);

    const unsynced = await savedMealsRepository.getUnsynced(USER_ID);
    expect(unsynced.map((m) => m.id)).toContain(MEAL_ID);
  });
});
