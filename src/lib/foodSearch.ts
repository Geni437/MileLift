import * as Network from 'expo-network';

import { supabase } from './supabase';
import { foodCacheRepository, type CacheableFood } from '../db/repositories/foodCacheRepository';
import type { FoodDataQuality, FoodMeasureBasis, FoodServing, FoodSource, LocalFoodCacheEntry } from '../db/types';

/**
 * The client-side wrapper around the two catalog-read RPCs
 * (`search_foods_v1`/`resolve_barcode_v1`) — architecture §2.2: "the client
 * MUST NOT ever `.select()` `foods`/`food_nutrients`/`food_servings`
 * unranged." Every catalog read funnels through here so that rule can never
 * be violated by a screen reaching for `supabase.from('foods')` directly.
 *
 * Offline behavior (§CORE-06 "Offline: search runs against the bounded
 * local cache"): a connectivity check runs FIRST so a doomed RPC call never
 * eats a network timeout before falling back — the offline path is
 * immediate, never a spinner waiting on a network that isn't there.
 */

export type FoodSearchItem = {
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
  defaultServing: FoodServing | null;
};

export type FoodSearchCursor = { rank_score: number; id: string } | null;

export type FoodSearchPage = {
  items: FoodSearchItem[];
  nextCursor: FoodSearchCursor;
  offline: boolean;
};

type RawSearchItem = {
  food_id: string;
  source: FoodSource;
  name: string;
  brand: string | null;
  barcode: string | null;
  basis: FoodMeasureBasis;
  energy_kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  data_quality: FoodDataQuality;
  attribution: string | null;
  default_serving: { id: string; label: string; gram_or_ml_weight: number } | null;
};

type SearchRpcResponse = {
  data?: { items: RawSearchItem[]; next_cursor: FoodSearchCursor };
  error?: { code: string; message: string; field: string | null };
};

async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return !!state.isConnected && state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

function toSearchItem(raw: RawSearchItem): FoodSearchItem {
  return {
    foodId: raw.food_id,
    source: raw.source,
    name: raw.name,
    brand: raw.brand,
    barcode: raw.barcode,
    basis: raw.basis,
    energyKcal: raw.energy_kcal,
    proteinG: raw.protein_g,
    carbG: raw.carb_g,
    fatG: raw.fat_g,
    dataQuality: raw.data_quality,
    attribution: raw.attribution,
    defaultServing: raw.default_serving ? { id: raw.default_serving.id, label: raw.default_serving.label, gramOrMlWeight: raw.default_serving.gram_or_ml_weight, isDefault: true } : null,
  };
}

function cacheEntryToSearchItem(entry: LocalFoodCacheEntry): FoodSearchItem {
  return {
    foodId: entry.foodId,
    source: entry.source,
    name: entry.name,
    brand: entry.brand,
    barcode: entry.barcode,
    basis: entry.basis,
    energyKcal: entry.energyKcal,
    proteinG: entry.proteinG,
    carbG: entry.carbG,
    fatG: entry.fatG,
    dataQuality: entry.dataQuality,
    attribution: entry.attribution,
    defaultServing: entry.servings.find((s) => s.isDefault) ?? entry.servings[0] ?? null,
  };
}

function toCacheable(item: FoodSearchItem, servings: FoodServing[]): CacheableFood {
  return {
    foodId: item.foodId,
    source: item.source,
    name: item.name,
    brand: item.brand,
    barcode: item.barcode,
    basis: item.basis,
    energyKcal: item.energyKcal,
    proteinG: item.proteinG,
    carbG: item.carbG,
    fatG: item.fatG,
    dataQuality: item.dataQuality,
    attribution: item.attribution,
    servings,
  };
}

const DEFAULT_LIMIT = 20;

/** Bounded, ranked, cursor-paginated search (`SEARCH §3`). Never an unranged `.select()`. */
export async function searchFoods(query: string, cursor: FoodSearchCursor, limit = DEFAULT_LIMIT): Promise<FoodSearchPage> {
  const trimmed = query.trim();
  if (!trimmed) return { items: [], nextCursor: null, offline: false };

  const online = await isOnline();
  if (!online) {
    const cached = await foodCacheRepository.search(trimmed, limit);
    return { items: cached.map(cacheEntryToSearchItem), nextCursor: null, offline: true };
  }

  const { data, error } = await supabase.rpc('search_foods_v1', { p_query: trimmed, p_cursor: cursor, p_limit: limit });
  if (error) {
    const cached = await foodCacheRepository.search(trimmed, limit);
    return { items: cached.map(cacheEntryToSearchItem), nextCursor: null, offline: true };
  }
  const body = data as SearchRpcResponse | null;
  if (body?.error || !body?.data) {
    const cached = await foodCacheRepository.search(trimmed, limit);
    return { items: cached.map(cacheEntryToSearchItem), nextCursor: null, offline: true };
  }

  const items = body.data.items.map(toSearchItem);
  await foodCacheRepository.cache(items.map((item) => toCacheable(item, item.defaultServing ? [item.defaultServing] : [])));
  return { items, nextCursor: body.data.next_cursor, offline: false };
}

export type BarcodeResolution =
  | { status: 'hit'; item: FoodSearchItem; servings: FoodServing[] }
  | { status: 'miss' }
  | { status: 'offline_miss' };

type RawBarcodeHit = {
  food_id: string;
  source: FoodSource;
  name: string;
  brand: string | null;
  barcode: string;
  basis: FoodMeasureBasis;
  energy_kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  data_quality: FoodDataQuality;
  attribution: string | null;
  servings: { id: string; label: string; gram_or_ml_weight: number; is_default: boolean }[];
};

type BarcodeRpcResponse = {
  data?: RawBarcodeHit;
  error?: { code: string; message: string; field: string | null };
};

/** CORE-07 barcode resolution flow (§2.4): local cache first, then the server point lookup if online, else an explicit offline-miss (routes to custom-food creation, never a dead end). */
export async function resolveBarcode(barcode: string): Promise<BarcodeResolution> {
  const cached = await foodCacheRepository.getByBarcode(barcode);
  if (cached) {
    return { status: 'hit', item: cacheEntryToSearchItem(cached), servings: cached.servings };
  }

  const online = await isOnline();
  if (!online) return { status: 'offline_miss' };

  const { data, error } = await supabase.rpc('resolve_barcode_v1', { p_barcode: barcode });
  if (error) return { status: 'offline_miss' };
  const body = data as BarcodeRpcResponse | null;
  if (body?.error) {
    if (body.error.code === 'BARCODE_NOT_FOUND') return { status: 'miss' };
    return { status: 'offline_miss' };
  }
  if (!body?.data) return { status: 'miss' };

  const servings: FoodServing[] = body.data.servings.map((s) => ({ id: s.id, label: s.label, gramOrMlWeight: s.gram_or_ml_weight, isDefault: s.is_default }));
  const item: FoodSearchItem = {
    foodId: body.data.food_id,
    source: body.data.source,
    name: body.data.name,
    brand: body.data.brand,
    barcode: body.data.barcode,
    basis: body.data.basis,
    energyKcal: body.data.energy_kcal,
    proteinG: body.data.protein_g,
    carbG: body.data.carb_g,
    fatG: body.data.fat_g,
    dataQuality: body.data.data_quality,
    attribution: body.data.attribution,
    defaultServing: servings.find((s) => s.isDefault) ?? servings[0] ?? null,
  };
  await foodCacheRepository.cache([toCacheable(item, servings)]);
  return { status: 'hit', item, servings };
}
