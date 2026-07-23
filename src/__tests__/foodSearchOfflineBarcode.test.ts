/**
 * Live-behavior test for the CORE-07 offline barcode-scan flow
 * (`src/lib/foodSearch.ts` `resolveBarcode`, the function
 * `app/(app)/food/scan.tsx`'s `handleScanned` calls directly).
 *
 * Exercises the REAL production function (not a re-implementation) against
 * mocked boundaries (`expo-network`, `foodCacheRepository`, `supabase`) —
 * the same technique `syncEngineConcurrency.test.ts` uses to test real sync
 * logic without touching expo-sqlite/native modules.
 *
 * Proves the two scenarios the task calls out concretely:
 *   1. A barcode previously resolved (search/scan/log) on this device is
 *      cached and resolves correctly OFFLINE, from the cache alone — no
 *      network call is attempted at all.
 *   2. A barcode NEVER seen on this device, scanned OFFLINE, fails
 *      gracefully (`offline_miss`) rather than hanging/crashing/throwing —
 *      `app/(app)/food/scan.tsx` routes both `miss` and `offline_miss`
 *      identically to custom-food creation.
 * Also covers the online-miss and online-transport-failure branches so the
 * "never a silent dead end" contract (architecture §2.4 step 3) is pinned
 * down for every branch, not just the two headline cases.
 */

import { resolveBarcode } from '../lib/foodSearch';
import { foodCacheRepository } from '../db/repositories/foodCacheRepository';
import { supabase } from '../lib/supabase';
import * as Network from 'expo-network';
import type { LocalFoodCacheEntry } from '../db/types';

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(),
}));

jest.mock('../db/repositories/foodCacheRepository', () => ({
  foodCacheRepository: {
    getByBarcode: jest.fn(),
    cache: jest.fn(),
    search: jest.fn(),
  },
}));

jest.mock('../lib/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

const CACHED_ENTRY: LocalFoodCacheEntry = {
  foodId: 'food-cached-1',
  source: 'usda_fdc',
  name: 'Cached Peanut Butter',
  brand: 'Acme',
  barcode: '0000111122223',
  basis: 'per_100g',
  energyKcal: 588,
  proteinG: 25,
  carbG: 20,
  fatG: 50,
  dataQuality: 'high',
  attribution: 'USDA FoodData Central',
  servings: [{ id: 'srv-1', label: '2 tbsp (32 g)', gramOrMlWeight: 32, isDefault: true }],
  cachedAt: '2026-07-01T00:00:00.000Z',
  lastUsedAt: '2026-07-20T00:00:00.000Z',
};

const NEVER_SEEN_BARCODE = '9999888877776';

describe('resolveBarcode — CORE-07 offline barcode scan (real cached dataset, narrower than the original design but real)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a PREVIOUSLY-RESOLVED barcode from the local cache while offline — no network call attempted', async () => {
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
    (foodCacheRepository.getByBarcode as jest.Mock).mockResolvedValue(CACHED_ENTRY);

    const result = await resolveBarcode(CACHED_ENTRY.barcode!);

    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.item.foodId).toBe('food-cached-1');
      expect(result.item.name).toBe('Cached Peanut Butter');
      expect(result.item.energyKcal).toBe(588);
      expect(result.servings).toEqual(CACHED_ENTRY.servings);
    }
    // The cache-first rule (§2.4 step 1): a cache hit never even checks
    // connectivity or calls the server RPC.
    expect(Network.getNetworkStateAsync).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a barcode NEVER seen on this device, scanned OFFLINE, fails gracefully (offline_miss) — never hangs, never throws, never crashes', async () => {
    (foodCacheRepository.getByBarcode as jest.Mock).mockResolvedValue(null);
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });

    const result = await resolveBarcode(NEVER_SEEN_BARCODE);

    expect(result.status).toBe('offline_miss');
    // No RPC call was attempted — the offline check short-circuits before
    // any doomed network request (architecture §CORE-06/07: "the offline
    // path is immediate, never a spinner waiting on a network that isn't
    // there").
    expect(supabase.rpc).not.toHaveBeenCalled();
    // Never silently cached as a false negative — a later reconnect must
    // still be able to try the real server lookup for this barcode.
    expect(foodCacheRepository.cache).not.toHaveBeenCalled();
  });

  it('a barcode never seen locally, resolved ONLINE, hits the server RPC and is cached for future offline use', async () => {
    (foodCacheRepository.getByBarcode as jest.Mock).mockResolvedValue(null);
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: {
        data: {
          food_id: 'food-new-1',
          source: 'open_food_facts',
          name: 'Newly Scanned Granola Bar',
          brand: 'Brand X',
          barcode: NEVER_SEEN_BARCODE,
          basis: 'per_100g',
          energy_kcal: 450,
          protein_g: 8,
          carb_g: 60,
          fat_g: 15,
          data_quality: 'medium',
          attribution: 'Open Food Facts contributors, ODbL',
          servings: [{ id: 'srv-2', label: '1 bar (40 g)', gram_or_ml_weight: 40, is_default: true }],
        },
      },
      error: null,
    });

    const result = await resolveBarcode(NEVER_SEEN_BARCODE);

    expect(result.status).toBe('hit');
    if (result.status === 'hit') expect(result.item.foodId).toBe('food-new-1');
    expect(supabase.rpc).toHaveBeenCalledWith('resolve_barcode_v1', { p_barcode: NEVER_SEEN_BARCODE });
    // This is exactly what grows the "real cached dataset" this device has
    // for future offline scans — the curated common-barcode pre-sync half of
    // the original design is unbuilt, but this on-device growth path is real.
    expect(foodCacheRepository.cache).toHaveBeenCalledTimes(1);
  });

  it('a genuine server BARCODE_NOT_FOUND (online, real catalog miss) routes to custom-food creation, not an offline_miss', async () => {
    (foodCacheRepository.getByBarcode as jest.Mock).mockResolvedValue(null);
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: { error: { code: 'BARCODE_NOT_FOUND', message: 'not found', field: 'barcode' } }, error: null });

    const result = await resolveBarcode(NEVER_SEEN_BARCODE);
    expect(result.status).toBe('miss');
  });

  it('a transport-level failure while "online" (RPC network error) degrades to offline_miss rather than throwing', async () => {
    (foodCacheRepository.getByBarcode as jest.Mock).mockResolvedValue(null);
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'fetch failed' } });

    const result = await resolveBarcode(NEVER_SEEN_BARCODE);
    expect(result.status).toBe('offline_miss');
  });
});
