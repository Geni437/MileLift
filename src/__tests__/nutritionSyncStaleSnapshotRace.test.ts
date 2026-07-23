/**
 * Stress test for `src/sync/nutritionSync.ts`'s `pushFoodLogEntries` /
 * `pushMealSave` — the same class of scrutiny this project already applies
 * to `workoutSync.ts` (`markFinishedAndSetsSynced`'s atomicity fix,
 * `syncEngineConcurrency.test.ts`'s re-entrancy race).
 *
 * `pushMealSave` (src/sync/nutritionSync.ts):
 *
 *   const dirtyItems = await foodLogRepository.getDirtyItems(entry.id);   // snapshot
 *   const pItems = dirtyItems.map(...);
 *   const { data, error } = await supabase.rpc('save_food_log_entry_v1', { p_items: pItems, ... }); // network round trip — yields the JS event loop
 *   ...
 *   await foodLogRepository.markSyncedWithServerTotals(entry.id, totals, dirtyItems.map((i) => i.id)); // clears dirty on the ORIGINAL snapshot's ids
 *
 * `dirtyItems` is captured ONCE, before the network round trip, and is never
 * re-read or re-validated after the RPC resolves. `markSyncedWithServerTotals`
 * then unconditionally clears `dirty = 0, server_confirmed = 1` on exactly
 * those ids (see `src/db/repositories/foodLogRepository.ts`).
 *
 * On a real device, the network round trip inside `await supabase.rpc(...)`
 * can take anywhere from tens of milliseconds to several seconds (exactly
 * the offline-first, flaky-network conditions this app targets). The JS
 * event loop is free during that await — the app is fully interactive. If
 * the user edits or removes the SAME item again during that window (e.g. on
 * `app/(app)/food/meal/[id].tsx`'s "Remove" button, wired directly to
 * `foodLogRepository.removeItem`), that edit is invisible to the in-flight
 * `pushMealSave` call: the RPC payload it already sent reflects the OLD
 * state, and the eventual `markSyncedWithServerTotals` call still clears
 * `dirty` on that item id — permanently marking the NEW, never-transmitted
 * edit as "synced" even though the server was never told about it. This is
 * the same structural class of bug as Phase 2's `markFinishedAndSetsSynced`
 * atomicity issue (a stale in-flight snapshot silently winning over a
 * later local write), and the identical pattern exists in
 * `workoutSync.ts`'s `pushWorkoutSave`/`getDirtySets` (out of this task's
 * nutrition scope, but flagged as the same recurring shape).
 *
 * Fixed by making the clear-dirty write a compare-and-swap on `updated_at`:
 * `foodLogRepository.markSyncedWithServerTotals` now takes `{id, updatedAt}`
 * pairs (the snapshot's `updated_at` at capture time) and its SQL is
 * `... WHERE id = ? AND updated_at IS ?` — if a concurrent edit landed
 * during the RPC's in-flight await, that edit already re-set both `dirty =
 * 1` and a newer `updated_at` (via `runUpsertItem`'s `ON CONFLICT DO
 * UPDATE`), so the conditional clear becomes a no-op and the item correctly
 * stays dirty for the next push instead of being falsely marked synced.
 *
 * This test proves `pushMealSave` (`src/sync/nutritionSync.ts`) correctly
 * threads each item's snapshot `updatedAt` through to
 * `markSyncedWithServerTotals` as the compare-and-swap key — the actual
 * SQL-level enforcement of "only clear dirty if unchanged since snapshot"
 * lives in `foodLogRepository.ts` itself (exercised separately by
 * `foodLogEditAfterSyncBug.test.ts`'s white-box repository test).
 */

import { pushFoodLogEntries } from '../sync/nutritionSync';

const mockResolveSoon = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 0));

const mockGetDirtyItems = jest.fn();
const mockMarkSyncedWithServerTotals = jest.fn((..._args: unknown[]) => mockResolveSoon(undefined));
const mockMarkFailed = jest.fn((..._args: unknown[]) => mockResolveSoon(undefined));
const mockGetUnsynced = jest.fn();

jest.mock('../db/repositories/foodLogRepository', () => ({
  foodLogRepository: {
    getUnsynced: (...args: unknown[]) => mockGetUnsynced(...args),
    getDirtyItems: (...args: unknown[]) => mockGetDirtyItems(...args),
    markSyncedWithServerTotals: (...args: unknown[]) => mockMarkSyncedWithServerTotals(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    wasServerConfirmed: () => mockResolveSoon(true),
    purgeLocalOnly: () => mockResolveSoon(undefined),
    markDeleteSynced: () => mockResolveSoon(undefined),
  },
}));

jest.mock('../db/repositories/customFoodsRepository', () => ({ customFoodsRepository: { getUnsynced: jest.fn(() => mockResolveSoon([])), getById: jest.fn() } }));
jest.mock('../db/repositories/waterIntakeRepository', () => ({ waterIntakeRepository: { getUnsynced: jest.fn(() => mockResolveSoon([])) } }));
jest.mock('../db/repositories/manualBurnRepository', () => ({ manualBurnRepository: { getUnsynced: jest.fn(() => mockResolveSoon([])) } }));
jest.mock('../db/repositories/savedMealsRepository', () => ({ savedMealsRepository: { getUnsynced: jest.fn(() => mockResolveSoon([])) } }));
jest.mock('../db/repositories/syncCursorRepository', () => ({ syncCursorRepository: { get: jest.fn(() => mockResolveSoon(null)), set: jest.fn(() => mockResolveSoon(undefined)) } }));
jest.mock('../db/repositories/foodCacheRepository', () => ({ foodCacheRepository: { getById: jest.fn() } }));

const mockRpc = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args), from: jest.fn() } }));

describe('pushMealSave — stale pre-RPC dirty-item snapshot (partial-confirmed-then-retry class)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks the item synced using the SNAPSHOT taken before the RPC call, never re-validated against the item state at RPC-resolution time', async () => {
    const entry = {
      id: 'meal-1',
      deletedAt: null,
      occurredAt: '2026-07-22T12:00:00.000Z',
      localDate: '2026-07-22',
      eventTimezone: 'UTC',
      mealType: 'lunch',
      source: 'manual',
      visibility: 'private',
      title: null,
      notes: null,
      clientCreatedAt: null,
    };
    mockGetUnsynced.mockResolvedValue([entry]);

    // The snapshot taken at the START of pushMealSave, before the network
    // round trip — item-1 as it existed at that instant (quantity 1).
    const snapshotItem = {
      id: 'item-1',
      foodId: 'food-1',
      customFoodId: null,
      foodNameSnapshot: 'Test Food',
      brandSnapshot: null,
      servingLabelSnapshot: '1 serving',
      quantity: 1,
      servingGOrMlSnapshot: 100,
      energyKcal: 100,
      proteinG: 10,
      carbG: 5,
      fatG: 2,
      dataQualitySnapshot: 'high',
      sortOrder: 0,
      deletedAt: null,
      updatedAt: '2026-07-22T12:00:00.000Z',
    };
    mockGetDirtyItems.mockResolvedValue([snapshotItem]);

    // The RPC call resolves on a real macrotask (a genuine network round
    // trip), giving the event loop a turn — during which, on a real device,
    // the user could remove/edit item-1 again via
    // app/(app)/food/meal/[id].tsx's wired "Remove" button.
    // Simulated here by simply recording that the RPC was called with the
    // STALE snapshot's fields (quantity 1) — proving the payload sent can
    // never reflect a concurrent edit that lands after this point.
    mockRpc.mockImplementation(() =>
      mockResolveSoon({
        data: { data: { id: 'meal-1', total_energy_kcal: 100, total_protein_g: 10, total_carb_g: 5, total_fat_g: 2, item_count: 1 } },
        error: null,
      })
    );

    await pushFoodLogEntries('user-1');

    // getDirtyItems is called EXACTLY ONCE — pushMealSave never re-fetches
    // the current dirty set after the RPC resolves to check whether
    // anything changed while the call was in flight.
    expect(mockGetDirtyItems).toHaveBeenCalledTimes(1);

    // markSyncedWithServerTotals is called with the id AND updatedAt from
    // the ORIGINAL snapshot (not re-derived from a fresh dirty-items read),
    // which is exactly what lets its own compare-and-swap WHERE clause
    // detect a later concurrent mutation: if item-1 were edited again
    // during the RPC round trip, its updated_at would have moved on, this
    // snapshot's stale value would no longer match, and the clear-dirty
    // write becomes a no-op instead of falsely marking synced.
    expect(mockMarkSyncedWithServerTotals).toHaveBeenCalledTimes(1);
    const [, , syncedItems] = mockMarkSyncedWithServerTotals.mock.calls[0];
    expect(syncedItems).toEqual([{ id: 'item-1', updatedAt: '2026-07-22T12:00:00.000Z' }]);

    // The RPC payload sent is provably the STALE snapshot (quantity: 1) —
    // there is no mechanism by which a later edit could have been included.
    const rpcCallArgs = mockRpc.mock.calls[0][1] as { p_items: { quantity: number }[] };
    expect(rpcCallArgs.p_items[0].quantity).toBe(1);
  });

  it('on a transport error, leaves the item dirty (never falsely marks synced) — the safe half of the same code path', async () => {
    const entry = {
      id: 'meal-2',
      deletedAt: null,
      occurredAt: '2026-07-22T12:00:00.000Z',
      localDate: '2026-07-22',
      eventTimezone: 'UTC',
      mealType: 'lunch',
      source: 'manual',
      visibility: 'private',
      title: null,
      notes: null,
      clientCreatedAt: null,
    };
    mockGetUnsynced.mockResolvedValue([entry]);
    mockGetDirtyItems.mockResolvedValue([{ id: 'item-2', quantity: 1, sortOrder: 0 }]);
    mockRpc.mockImplementation(() => mockResolveSoon({ data: null, error: { message: 'network timeout' } }));

    await pushFoodLogEntries('user-1');

    expect(mockMarkFailed).toHaveBeenCalledWith('meal-2', 'network timeout');
    expect(mockMarkSyncedWithServerTotals).not.toHaveBeenCalled();
  });
});
