/**
 * Regression test for a REAL bug found during Phase 3 gate review (mirrors
 * the discipline of `syncEngineConcurrency.test.ts`, which documents Phase
 * 2's `runSync` re-entrancy race).
 *
 * `app/(app)/food/meal/[id].tsx` ("meal detail") is the shipped, wired
 * screen for CORE-06's promised "editable, self-correcting log" (design doc
 * §7 "Correction" / §6 AI-11 substrate) — its `handleRemoveItem` calls
 * `foodLogRepository.removeItem(itemId)` directly on an ALREADY-SYNCED meal,
 * then `runSync('post-write')`, with NO subsequent `commit()` call.
 *
 * `foodLogRepository.removeItem()` soft-deletes the item (`dirty = 1`) and
 * recomputes the parent meal's local snapshot totals via `recomputeTotals()`
 * — but NEITHER of those touches `food_log_entries.sync_status`. The ONLY
 * code path that ever sets `sync_status = 'pending'` is `commit()`
 * (`food_log_entries.sync_status = 'pending'`), which nothing on the
 * meal-detail "Remove" path calls.
 *
 * Net effect (proven below against the REAL repository logic, not a
 * re-implementation): removing a food item from an already-synced meal via
 * the meal-detail screen recomputes the local total correctly for display,
 * but the meal's `sync_status` stays `'synced'` — so `getUnsynced()` (what
 * `pushFoodLogEntries` in `src/sync/nutritionSync.ts` queries) NEVER returns
 * it again. The removal, and the corrected total, are silently never pushed
 * to the server. Worse: because `sync_status` still reads `'synced'`, the
 * NEXT `pullFoodLogEntries()` will pass `reconcileEntryFromServer`'s
 * "don't clobber an unsynced local edit" guard (which only checks
 * `sync_status !== 'synced'`) and overwrite the meal's locally-corrected
 * `total_energy_kcal`/macros back to the server's STALE pre-removal values —
 * silently resurrecting the removed item's calories into the displayed
 * total (while the item itself stays correctly hidden, protected by its own
 * `dirty = 1` item-level guard). This directly threatens CORE-11/CORE-08
 * accuracy: the server-side `timeline_events.energy_kcal` this meal feeds
 * `get_daily_energy_balance_v1`'s `calories_in_kcal` also never learns about
 * the removal, since the RPC that would update it is never called.
 *
 * This is NOT a hypothetical race — it was 100% deterministic on the exact
 * wired path `app/(app)/food/meal/[id].tsx` calls. It is the mirror-image of
 * Module C's `markFinishedAndSetsSynced` atomicity fix (which correctly
 * flips session+sets to synced together) — but here nothing ever flipped the
 * parent BACK to pending after a post-sync edit at all.
 *
 * Fixed by `markEntryDirtyIfCommitted` (`src/db/repositories/foodLogRepository.ts`),
 * called from both `removeItem` and `upsertItem` after `recomputeTotals` —
 * re-enqueues an already-committed entry (`sync_status -> 'pending'`)
 * whenever its items change post-sync, leaving a never-yet-committed draft
 * (`committed_at IS NULL`) untouched since only `commit()` should move that
 * one out of `'local'`. This test now asserts and confirms the fixed
 * behavior.
 */

import { foodLogRepository } from '../db/repositories/foodLogRepository';

type EntryRow = {
  id: string;
  user_id: string;
  meal_type: string;
  title: string | null;
  notes: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  total_energy_kcal: number;
  total_protein_g: number | null;
  total_carb_g: number | null;
  total_fat_g: number | null;
  source: string;
  visibility: string;
  client_created_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  committed_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ItemRow = {
  id: string;
  timeline_event_id: string;
  user_id: string;
  food_id: string | null;
  custom_food_id: string | null;
  food_name_snapshot: string;
  brand_snapshot: string | null;
  serving_label_snapshot: string;
  quantity: number;
  serving_g_or_ml_snapshot: number;
  energy_kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  data_quality_snapshot: string | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  dirty: number;
  server_confirmed: number;
};

/**
 * A minimal in-memory stand-in for the `expo-sqlite` handle, implementing
 * ONLY the exact literal query shapes `foodLogRepository` issues along the
 * `removeItem` -> `recomputeTotals` -> `getUnsynced` path (verified by
 * reading `src/db/repositories/foodLogRepository.ts` directly) — a
 * white-box repository test, the same class as this project's existing
 * `syncEngineConcurrency.test.ts`.
 */
function mockCreateFakeDb(entries: EntryRow[], items: ItemRow[]) {
  return {
    async getFirstAsync(sql: string, params: unknown[]) {
      if (sql.includes('FROM food_log_items WHERE id = ?')) {
        return items.find((i) => i.id === params[0]) ?? null;
      }
      if (sql.includes('SELECT server_confirmed FROM food_log_entries WHERE id = ?')) {
        const e = entries.find((e) => e.id === params[0]);
        return e ? { server_confirmed: e.server_confirmed } : null;
      }
      if (sql.includes('FROM food_log_entries WHERE id = ?')) {
        return entries.find((e) => e.id === params[0]) ?? null;
      }
      throw new Error(`Unhandled getFirstAsync: ${sql}`);
    },
    async getAllAsync(sql: string, params: unknown[]) {
      if (sql.includes('FROM food_log_items WHERE timeline_event_id = ? AND deleted_at IS NULL')) {
        return items.filter((i) => i.timeline_event_id === params[0] && i.deleted_at == null).sort((a, b) => a.sort_order - b.sort_order);
      }
      if (sql.includes('FROM food_log_items WHERE timeline_event_id = ?') && sql.includes('dirty = 1')) {
        return items.filter((i) => i.timeline_event_id === params[0] && i.dirty === 1);
      }
      if (sql.includes(`sync_status IN ('pending', 'failed')`)) {
        return entries.filter((e) => e.user_id === params[0] && e.committed_at != null && (e.sync_status === 'pending' || e.sync_status === 'failed'));
      }
      throw new Error(`Unhandled getAllAsync: ${sql}`);
    },
    async runAsync(sql: string, params: unknown[]) {
      if (sql.startsWith('DELETE FROM food_log_items WHERE id = ?')) {
        const idx = items.findIndex((i) => i.id === params[0]);
        if (idx >= 0) items.splice(idx, 1);
        return;
      }
      if (sql.includes('UPDATE food_log_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?')) {
        const item = items.find((i) => i.id === params[2]);
        if (item) {
          item.deleted_at = params[0] as string;
          item.updated_at = params[1] as string;
          item.dirty = 1;
        }
        return;
      }
      if (sql.includes('UPDATE food_log_entries SET total_energy_kcal = ?, total_protein_g = ?, total_carb_g = ?, total_fat_g = ?, updated_at = ? WHERE id = ?')) {
        const e = entries.find((e) => e.id === params[5]);
        if (e) {
          e.total_energy_kcal = params[0] as number;
          e.total_protein_g = params[1] as number | null;
          e.total_carb_g = params[2] as number | null;
          e.total_fat_g = params[3] as number | null;
          e.updated_at = params[4] as string;
        }
        return;
      }
      // markEntryDirtyIfCommitted's re-enqueue write (checked BEFORE the more
      // generic commit() branch below — both contain "sync_status =
      // 'pending'", but this one only binds 2 params [updated_at, id] and
      // requires committed_at IS NOT NULL, so it must be matched first or
      // the generic branch below misreads params[2] as the id (undefined)
      // and silently no-ops).
      if (sql.includes(`SET sync_status = 'pending', updated_at = ?, last_sync_error = NULL`) && sql.includes('committed_at IS NOT NULL')) {
        const e = entries.find((e) => e.id === params[1]);
        if (e && e.committed_at != null && e.sync_status !== 'pending') {
          e.updated_at = params[0] as string;
          e.sync_status = 'pending';
          e.last_sync_error = null;
        }
        return;
      }
      if (sql.includes(`sync_status = 'pending'`)) {
        const e = entries.find((e) => e.id === params[2]);
        if (e) {
          e.committed_at = params[0] as string;
          e.updated_at = params[1] as string;
          e.sync_status = 'pending';
          e.last_sync_error = null;
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

let mockFakeEntries: EntryRow[];
let mockFakeItems: ItemRow[];

jest.mock('../db/client', () => ({
  getDb: jest.fn(async () => mockCreateFakeDb(mockFakeEntries, mockFakeItems)),
}));

const MEAL_ID = 'meal-already-synced-1';
const USER_ID = 'user-1';
const ITEM_ID = 'item-already-synced-1';

describe('foodLogRepository.removeItem on an ALREADY-SYNCED meal (app/(app)/food/meal/[id].tsx "Remove" path)', () => {
  beforeEach(() => {
    // One meal already fully synced (server_confirmed, sync_status=synced),
    // with one server-confirmed item worth 300 kcal — exactly the state a
    // meal is in after its first successful push.
    mockFakeEntries = [
      {
        id: MEAL_ID,
        user_id: USER_ID,
        meal_type: 'lunch',
        title: null,
        notes: null,
        occurred_at: '2026-07-22T12:00:00.000Z',
        local_date: '2026-07-22',
        event_timezone: 'UTC',
        total_energy_kcal: 300,
        total_protein_g: 20,
        total_carb_g: 10,
        total_fat_g: 5,
        source: 'manual',
        visibility: 'private',
        client_created_at: null,
        created_at: '2026-07-22T12:00:00.000Z',
        updated_at: '2026-07-22T12:00:00.000Z',
        deleted_at: null,
        committed_at: '2026-07-22T12:00:00.000Z',
        server_confirmed: 1,
        sync_status: 'synced',
        last_sync_error: null,
      },
    ];
    mockFakeItems = [
      {
        id: ITEM_ID,
        timeline_event_id: MEAL_ID,
        user_id: USER_ID,
        food_id: 'food-1',
        custom_food_id: null,
        food_name_snapshot: 'Test Food',
        brand_snapshot: null,
        serving_label_snapshot: '1 serving',
        quantity: 1,
        serving_g_or_ml_snapshot: 100,
        energy_kcal: 300,
        protein_g: 20,
        carb_g: 10,
        fat_g: 5,
        data_quality_snapshot: 'high',
        sort_order: 0,
        deleted_at: null,
        created_at: '2026-07-22T12:00:00.000Z',
        updated_at: '2026-07-22T12:00:00.000Z',
        dirty: 0,
        server_confirmed: 1,
      },
    ];
  });

  it('re-enqueues the meal for push (sync_status -> pending) after removing an item from an already-synced meal', async () => {
    await foodLogRepository.removeItem(ITEM_ID);

    const entryAfter = await foodLogRepository.getEntry(MEAL_ID);
    // The item removal itself works locally (this part is NOT buggy):
    expect(entryAfter?.totalEnergyKcal).toBe(0);

    // THE BUG: this assertion is what SHOULD be true for the removal to ever
    // reach the server, but the current implementation leaves sync_status
    // untouched at 'synced'.
    expect(entryAfter?.syncStatus).toBe('pending');
  });

  it('is returned by getUnsynced() so the next sync push actually sends the removal to the server', async () => {
    await foodLogRepository.removeItem(ITEM_ID);

    const unsynced = await foodLogRepository.getUnsynced(USER_ID);
    // THE BUG, observed at the exact call site `pushFoodLogEntries` uses: a
    // meal edited after its first sync is silently invisible to every
    // future sync pass forever (until some UNRELATED future edit happens to
    // call `commit()` again, which no code path on this screen does).
    expect(unsynced.map((e) => e.id)).toContain(MEAL_ID);
  });
});
