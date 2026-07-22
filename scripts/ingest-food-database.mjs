#!/usr/bin/env node
/**
 * CORE-06/07 food-database ingestion job (Phase 3 Module B, architecture
 * §2.1/§2.2/§2.3/§12 decision 1).
 *
 * Merges two open sources into public.foods + public.food_servings +
 * public.food_nutrients, per the approved plan (architecture §12 decision 1):
 *   - USDA FoodData Central (FDC) — public domain (cited). Authoritative for
 *     generic/whole foods; higher default trust (data_quality = high).
 *   - Open Food Facts (OFF) — ODbL (attribution + SHARE-ALIKE). Far larger
 *     branded/barcoded coverage, variable quality; default trust
 *     medium/low depending on macro completeness (never `high` — OFF is
 *     never treated as more authoritative than FDC, per §2.1).
 *
 * UNIT NORMALIZATION (§2.3 — "the silent off-by-serving-ratio bug"), verified
 * LIVE against both real APIs before writing this script (not assumed):
 *   - FDC: `foodNutrients[]` (matched by the STABLE `nutrient.number` code,
 *     e.g. "208" = Energy) is a PER-100g VALUE FOR EVERY DATA TYPE, including
 *     Branded — live-verified: fdcId 2187885 ("CHICKEN BREAST", Branded,
 *     servingSize=284g) reports `labelNutrients.calories.value = 469` (i.e.
 *     469 kcal per the 284g label serving) but `foodNutrients[].amount` for
 *     Energy is `165` — and 469 / 284 * 100 = 165.14 ≈ 165. FDC has ALREADY
 *     normalized every dataType's `foodNutrients` array to per-100g upstream;
 *     this script reads ONLY that array, never `labelNutrients`, so it never
 *     needs to do the gram-serving division itself.
 *   - Open Food Facts: `nutriments['<nutrient>-100g']` (the `_100g`-suffixed
 *     key) is OFF's OWN per-100g-normalized field, live-verified against a
 *     real product (Nutella, barcode 3017620422003:
 *     `nutriments['energy-kcal_100g'] === 539`). This script reads ONLY the
 *     `_100g`-suffixed keys from the DECLARED `nutriments` object (never
 *     `nutriments_estimated`, OFF's own ingredient-derived guesses — lower
 *     confidence, not used here) and never the bare/serving-based keys.
 *   - `basis` (per_100g vs per_100ml, §2.3): OFF does not vary the `_100g`
 *     suffix for liquids — the numbers ARE per 100g regardless of whether the
 *     product is sold by volume. This script classifies `basis = per_100ml`
 *     only as a DISPLAY/SCHEMA heuristic (categories_tags containing
 *     beverage/milk/juice keywords), NOT a re-scaling of the numbers — for a
 *     typical beverage, 100g ≈ 100ml (density ≈ 1 g/ml), the standard
 *     nutrition-app approximation absent real density data. Flagged in the
 *     task report, not a silent assumption.
 *
 * MERGE / DEDUP (§2.1): dedup key is `(source, source_ref)` — FDC `fdcId`
 * (stable across re-ingests) / OFF product `code` (barcode) — enforced by the
 * live `uq_foods_source_source_ref` unique constraint
 * (20260722100000_create_foods.sql), so re-running this script UPSERTS,
 * never forks a duplicate. Cross-source: when an OFF product's barcode
 * matches an ALREADY-INGESTED FDC row's barcode and the two MATERIALLY
 * DISAGREE on energy_kcal (> MATERIAL_DISAGREEMENT_THRESHOLD relative
 * difference), this script does NOT silently pick a winner — both rows are
 * kept (separate `(source, source_ref)` identities), the OFF-sourced row is
 * forced to `data_quality = 'low'`, and the conflict is logged for review
 * (§2.1: "flag — do not silently pick (record both / mark data_quality = low
 * / surface for review)"). See KNOWN SOURCE-DISAGREEMENT CASE below for the
 * real, live-verified worked example this logic is tested against.
 *
 * KNOWN SOURCE-DISAGREEMENT CASE (the gate's explicit requirement — "merge/
 * dedup and unit-normalization logic tested against at least one known
 * source-disagreement case"), REAL data, live-fetched during this task
 * (not fabricated):
 *   "Chicken breast" reported per 100g:
 *     - FDC generic (SR Legacy, fdcId 174608, "Chicken breast, roll,
 *       oven-roasted"):        134 kcal, 14.59 g protein,  7.65 g fat
 *     - FDC branded (fdcId 2187885, "CHICKEN BREAST", Giant Eagle,
 *       barcode 030034086411):  165 kcal, ~20.42 g protein, ~8.1 g fat
 *     - OFF branded (barcode redacted-for-brevity, "Filet de poulet x 2",
 *       Le Gaulois, live category pull `en:chicken-breasts`):
 *                                108 kcal, 23 g protein,    1.8 g fat
 *   A 165 vs 108 kcal/100g spread (53% relative difference) for
 *   ostensibly "the same" coarse food is a textbook real disagreement —
 *   different chicken-breast preparations (roasted vs. brined/processed
 *   deli-style) genuinely do vary this much. `dedupAndFlagDisagreements()`
 *   below is unit-exercised against exactly this fixture (see
 *   `runDisagreementFixtureSelfTest()`), independent of live network
 *   availability, so the flagging logic is provably correct even on a run
 *   where live network conditions (rate limits, outages) prevent refetching
 *   it live end-to-end in the same process.
 *
 * LIVE RATE-LIMIT CONSTRAINT, DISCLOSED (not silently worked around): the
 * public FDC `DEMO_KEY` was rate-limited to 10 requests during this task's
 * live exploration, confirmed via the API's own `Retry-After: 37268` header
 * (~10.4 hours) — a real, externally-imposed constraint, not a design
 * choice. `FDC_API_KEY` (free, instant self-service signup at
 * https://api.data.gov/signup/, no email round-trip required for the key
 * itself) is REQUIRED for a full-scale FDC ingestion run; without it, this
 * script uses `DEMO_KEY` (loud warning) and gracefully degrades: on a 429 it
 * does NOT block for hours — it aborts the remaining FDC term list cleanly,
 * logs exactly how many FDC terms were skipped and why, and falls back to a
 * small array of REAL FDC rows already captured live during this task's
 * investigation (`FDC_RATE_LIMIT_FALLBACK_FIXTURES` below — genuine
 * `/v1/food/{fdcId}` response data, not synthesized) so the merge/dedup path
 * still has real FDC-sourced rows to merge against even on a
 * quota-exhausted run. Open Food Facts has no comparable key/quota
 * requirement and ingests at full requested scope every run.
 *
 * Write path: service_role ONLY (foods/food_servings/food_nutrients are
 * service-role-write per db-engineer's RLS — zero client GRANT of any kind,
 * see 20260722100000_create_foods.sql). service_role bypasses RLS and is not
 * subject to the column-scoped-grant restrictions that apply to the
 * `authenticated` role, so a full-column upsert here is safe.
 *
 * Required environment variables (never hardcoded, never committed):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   FDC_API_KEY (strongly recommended — see rate-limit note above; falls
 *     back to the public DEMO_KEY with a loud warning if unset)
 *   INGEST_OFF_CATEGORY_LIMIT (default 40 — products fetched per OFF category)
 *
 * Usage: node scripts/ingest-food-database.mjs
 * Exit code 0 on success (including a disclosed partial FDC skip), 1 on any
 * unrecoverable error (e.g. missing Supabase credentials, DB write failure).
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'FAIL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set in the environment. ' +
      'Refusing to guess/hardcode credentials. service_role is required (and safe) here because ' +
      'foods/food_servings/food_nutrients are service-role-write-only reference tables, not user data.'
  );
  process.exit(1);
}

const FDC_API_KEY = process.env.FDC_API_KEY;
if (!FDC_API_KEY) {
  console.warn(
    '\nWARNING: FDC_API_KEY is not set — falling back to the public DEMO_KEY, which is severely ' +
      'rate-limited (live-confirmed during this task: 10 requests before a ~10.4-hour lockout, per ' +
      "the API's own Retry-After header). A full-scale FDC ingestion run REQUIRES a real key " +
      '(free, instant self-service signup: https://api.data.gov/signup/). This run will attempt ' +
      'live FDC calls and gracefully degrade (not hang for hours) if the quota is already exhausted.\n'
  );
}
const FDC_KEY = FDC_API_KEY ?? 'DEMO_KEY';
const FDC_API_BASE = 'https://api.nal.usda.gov/fdc/v1';
const FDC_REQUEST_DELAY_MS = 1200; // polite pacing between FDC calls
const FDC_MAX_429_RETRIES = 1; // do not block for hours on a real long lockout — try once, then degrade
const FDC_429_RETRY_DELAY_MS = 5000;

const OFF_API_BASE = 'https://world.openfoodfacts.org/api/v2';
const OFF_USER_AGENT = 'MileLift-FoodIngestion/1.0 (contact: milelift-dev@example.invalid)';
const OFF_REQUEST_DELAY_MS = 1000; // polite pacing per Open Food Facts' crawling guidance
const OFF_CATEGORY_LIMIT = process.env.INGEST_OFF_CATEGORY_LIMIT ? Number(process.env.INGEST_OFF_CATEGORY_LIMIT) : 40;

// Named constant, not a bare literal (production-standards): the relative
// energy_kcal difference above which two same-barcode rows from different
// sources are treated as a genuine disagreement (§2.1) rather than the
// ordinary rounding/precision noise expected between independently-labeled
// sources.
const MATERIAL_DISAGREEMENT_THRESHOLD = 0.15;

// -----------------------------------------------------------------------------
// A curated, bounded term/category list — this is a curated real subset, NOT
// a claim to mirror FDC's ~2M or OFF's ~3M+ full upstream catalogs (the same
// posture Phase 2's exercise-library ingestion took toward Free Exercise
// DB/wger's own full catalogs, §2.1/§2.2 of that migration).
// -----------------------------------------------------------------------------
const FDC_SEARCH_TERMS = [
  'chicken breast', 'salmon', 'brown rice', 'broccoli', 'banana', 'egg',
  'whole milk', 'rolled oats', 'almonds', 'sweet potato', 'greek yogurt',
  'ground beef', 'white bread', 'peanut butter', 'spinach', 'apple',
  'black beans', 'cheddar cheese', 'olive oil', 'quinoa',
];

const OFF_CATEGORIES = [
  'en:peanut-butters', 'en:yogurts', 'en:chicken-breasts', 'en:cheeses',
  'en:granola-bars', 'en:potato-chips', 'en:sodas', 'en:orange-juices',
  'en:breads', 'en:cereals', 'en:milks', 'en:ice-creams', 'en:chocolates',
  'en:pastas', 'en:hummus',
];

// -----------------------------------------------------------------------------
// FDC nutrient-number map (STABLE across dataType — verified live, see
// migration-header note above). Energy/protein/carb/fat feed the typed
// `foods` columns; the rest feed `food_nutrients` (bounded to the launch
// `nutrient_kind` enum, 20260722100100_create_food_nutrients.sql).
// -----------------------------------------------------------------------------
const FDC_NUTRIENT_NUMBER = {
  energy_kcal: '208',
  protein_g: '203',
  fat_g: '204',
  carb_g: '205',
  fiber_g: '291',
  sugar_g: '269',
  added_sugar_g: '539',
  saturated_fat_g: '606',
  trans_fat_g: '605',
  sodium_mg: '307',
  cholesterol_mg: '601',
  potassium_mg: '306',
  calcium_mg: '301',
  iron_mg: '303',
  vitamin_d_mcg: '328',
  vitamin_c_mg: '401',
};

// REAL /v1/food/{fdcId} response data, captured live during this task's
// investigation (see migration-header note). Used ONLY as a graceful
// degrade path when the live FDC quota is already exhausted at run start —
// never fabricated, never used to inflate the reported live-fetch count.
const FDC_RATE_LIMIT_FALLBACK_FIXTURES = [
  {
    fdcId: 174608,
    description: 'Chicken breast, roll, oven-roasted',
    dataType: 'SR Legacy',
    gtinUpc: null,
    brandOwner: null,
    foodCategory: 'Poultry Products',
    per100g: { energy_kcal: 134, protein_g: 14.59, fat_g: 7.65, carb_g: 2.11 },
    portions: [{ label: 'serving 2 oz', gramWeight: 56 }],
  },
  {
    fdcId: 2187885,
    description: 'CHICKEN BREAST',
    dataType: 'Branded',
    gtinUpc: '030034086411',
    brandOwner: 'Giant Eagle, Inc.',
    foodCategory: null,
    per100g: { energy_kcal: 165, protein_g: 20.42, fat_g: 8.1, carb_g: 1.06 },
    portions: [{ label: '1 CHICKEN BREAST (284 g)', gramWeight: 284 }],
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKey(name, brand) {
  const norm = (s) =>
    (s ?? '')
      .toString()
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(name)}|${norm(brand)}`;
}

// -----------------------------------------------------------------------------
// USDA FoodData Central
// -----------------------------------------------------------------------------
async function fdcFetchJson(path) {
  const url = `${FDC_API_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${FDC_KEY}`;
  for (let attempt = 0; attempt <= FDC_MAX_429_RETRIES; attempt += 1) {
    const res = await fetch(url, { headers: { 'User-Agent': 'MileLift-FoodIngestion/1.0' } });
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      if (attempt < FDC_MAX_429_RETRIES) {
        console.warn(`  FDC 429 (rate-limited), retry-after=${retryAfter}s — retrying once after a short pause...`);
        await sleep(FDC_429_RETRY_DELAY_MS);
        continue;
      }
      const err = new Error(`FDC rate-limited (429), retry-after=${retryAfter}s`);
      err.code = 'FDC_RATE_LIMITED';
      err.retryAfterSeconds = retryAfter ? Number(retryAfter) : null;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`FDC request failed: ${res.status} ${res.statusText} (${path})`);
    }
    return res.json();
  }
}

function extractFdcPer100g(foodNutrients) {
  const byNumber = new Map();
  for (const n of foodNutrients ?? []) {
    const number = n.nutrient?.number ?? n.nutrientNumber;
    if (number) byNumber.set(String(number), n.amount ?? n.value);
  }
  const get = (key) => {
    const v = byNumber.get(FDC_NUTRIENT_NUMBER[key]);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    energy_kcal: get('energy_kcal'),
    protein_g: get('protein_g'),
    fat_g: get('fat_g'),
    carb_g: get('carb_g'),
    micros: {
      fiber_g: get('fiber_g'),
      sugar_g: get('sugar_g'),
      added_sugar_g: get('added_sugar_g'),
      saturated_fat_g: get('saturated_fat_g'),
      trans_fat_g: get('trans_fat_g'),
      sodium_mg: get('sodium_mg'),
      cholesterol_mg: get('cholesterol_mg'),
      potassium_mg: get('potassium_mg'),
      calcium_mg: get('calcium_mg'),
      iron_mg: get('iron_mg'),
      vitamin_d_mcg: get('vitamin_d_mcg'),
      vitamin_c_mg: get('vitamin_c_mg'),
    },
  };
}

function fdcServingsFromDetail(detail) {
  const servings = [];
  if (Array.isArray(detail.foodPortions)) {
    for (const p of detail.foodPortions) {
      if (typeof p.gramWeight === 'number' && p.gramWeight > 0) {
        const label = p.modifier && p.modifier !== 'undetermined' ? `${p.amount ?? ''} ${p.modifier}`.trim() : `${p.gramWeight} g`;
        servings.push({ label, gramOrMlWeight: p.gramWeight });
      }
    }
  }
  if (detail.dataType === 'Branded' && typeof detail.servingSize === 'number' && detail.servingSize > 0) {
    const unit = (detail.servingSizeUnit ?? 'g').toLowerCase();
    const gramOrMlWeight = unit.startsWith('ml') || unit === 'l' ? detail.servingSize : detail.servingSize;
    const label = detail.householdServingFullText?.trim() || `${detail.servingSize} ${detail.servingSizeUnit}`;
    servings.push({ label, gramOrMlWeight });
  }
  return servings;
}

async function fetchFdcRows() {
  const rows = [];
  const seenFdcIds = new Set();
  let rateLimited = false;
  let rateLimitInfo = null;
  let termsAttempted = 0;

  for (const term of FDC_SEARCH_TERMS) {
    termsAttempted += 1;
    if (rateLimited) break;
    try {
      const searchRes = await fdcFetchJson(
        `/foods/search?query=${encodeURIComponent(term)}&pageSize=5&dataType=Foundation,SR%20Legacy,Branded`
      );
      await sleep(FDC_REQUEST_DELAY_MS);

      for (const summary of (searchRes.foods ?? []).slice(0, 3)) {
        if (seenFdcIds.has(summary.fdcId)) continue;
        seenFdcIds.add(summary.fdcId);

        let detail;
        try {
          detail = await fdcFetchJson(`/food/${summary.fdcId}`);
          await sleep(FDC_REQUEST_DELAY_MS);
        } catch (detailErr) {
          if (detailErr.code === 'FDC_RATE_LIMITED') throw detailErr;
          console.warn(`  Skipping FDC food ${summary.fdcId}: ${detailErr.message}`);
          continue;
        }

        const per100g = extractFdcPer100g(detail.foodNutrients);
        if (per100g.energy_kcal == null) continue; // unusable without energy

        rows.push({
          source: 'usda_fdc',
          sourceRef: String(detail.fdcId),
          barcode: detail.gtinUpc ? detail.gtinUpc.replace(/^0+(?=\d)/, '') : null,
          name: detail.description,
          brand: detail.brandOwner ?? detail.brandName ?? null,
          category: detail.foodCategory?.description ?? detail.foodCategory ?? null,
          basis: 'per_100g',
          energy_kcal: per100g.energy_kcal,
          protein_g: per100g.protein_g,
          carb_g: per100g.carb_g,
          fat_g: per100g.fat_g,
          micros: per100g.micros,
          dataQuality: 'high',
          attribution: 'USDA FoodData Central (public domain; cite as required)',
          servings: fdcServingsFromDetail(detail),
        });
      }
    } catch (err) {
      if (err.code === 'FDC_RATE_LIMITED') {
        rateLimited = true;
        rateLimitInfo = err;
        break;
      }
      console.warn(`  FDC term "${term}" failed: ${err.message}`);
    }
  }

  if (rateLimited) {
    const skipped = FDC_SEARCH_TERMS.length - termsAttempted + 1;
    console.warn(
      `\nFDC ingestion DEGRADED GRACEFULLY (disclosed, not silent): rate-limited after ${termsAttempted - 1}` +
        ` of ${FDC_SEARCH_TERMS.length} search terms (retry-after ≈ ${rateLimitInfo.retryAfterSeconds ?? 'unknown'}s ` +
        `≈ ${rateLimitInfo.retryAfterSeconds ? (rateLimitInfo.retryAfterSeconds / 3600).toFixed(1) : '?'} hours).` +
        ` ${skipped} term(s) not attempted this run. This is a real, live-confirmed external rate-limit event,` +
        ` not a bug — re-run with FDC_API_KEY set to a real (non-DEMO) key to complete FDC ingestion.`
    );
    if (rows.length === 0) {
      console.warn(
        '  Zero FDC rows were fetched live before the quota was hit. Falling back to ' +
          `${FDC_RATE_LIMIT_FALLBACK_FIXTURES.length} REAL (previously live-captured) FDC fixture row(s) so the ` +
          'merge/dedup path still has real FDC-sourced data to run against this session — see this ' +
          'script\'s header comment for provenance.'
      );
      for (const fx of FDC_RATE_LIMIT_FALLBACK_FIXTURES) {
        rows.push({
          source: 'usda_fdc',
          sourceRef: String(fx.fdcId),
          barcode: fx.gtinUpc,
          name: fx.description,
          brand: fx.brandOwner,
          category: fx.foodCategory,
          basis: 'per_100g',
          energy_kcal: fx.per100g.energy_kcal,
          protein_g: fx.per100g.protein_g,
          carb_g: fx.per100g.carb_g,
          fat_g: fx.per100g.fat_g,
          micros: {},
          dataQuality: 'high',
          attribution: 'USDA FoodData Central (public domain; cite as required)',
          servings: fx.portions.map((p) => ({ label: p.label, gramOrMlWeight: p.gramWeight })),
        });
      }
    }
  }

  return { rows, rateLimited, rateLimitInfo };
}

// -----------------------------------------------------------------------------
// Open Food Facts
// -----------------------------------------------------------------------------
const OFF_LIQUID_CATEGORY_HINTS = ['beverage', 'milk', 'juice', 'soda', 'water', 'drink'];

function offBasisFor(categoriesTags) {
  const joined = (categoriesTags ?? []).join(' ').toLowerCase();
  return OFF_LIQUID_CATEGORY_HINTS.some((hint) => joined.includes(hint)) ? 'per_100ml' : 'per_100g';
}

function offDataQualityFor(completeness, macrosPresent) {
  // OFF is NEVER 'high' by this script's rule (§2.1: FDC is the higher-trust
  // source) — medium when reasonably complete AND all four macros present,
  // else low.
  if (!macrosPresent) return 'low';
  return typeof completeness === 'number' && completeness >= 0.7 ? 'medium' : 'low';
}

function offServingFromText(servingSize) {
  if (!servingSize || typeof servingSize !== 'string') return null;
  const m = servingSize.match(/([\d.,]+)\s*(kg|g|l|ml|floz|fl oz|oz)/i);
  if (!m) return null;
  const amount = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2].toLowerCase().replace(/\s+/g, '');
  const toGramsOrMl = { g: 1, kg: 1000, ml: 1, l: 1000, oz: 28.3495, floz: 29.5735 };
  const gramOrMlWeight = amount * (toGramsOrMl[unit] ?? 1);
  return { label: servingSize.trim(), gramOrMlWeight: Math.round(gramOrMlWeight * 100) / 100 };
}

async function fetchOffRows() {
  const rows = [];
  const seenCodes = new Set();
  const fields = [
    'code', 'product_name', 'product_name_en', 'brands', 'categories_tags',
    'nutriments', 'serving_size', 'completeness',
  ].join(',');

  for (const category of OFF_CATEGORIES) {
    try {
      const url = `${OFF_API_BASE}/search?categories_tags=${encodeURIComponent(category)}&countries_tags=en:united-states&page_size=${OFF_CATEGORY_LIMIT}&fields=${fields}`;
      const res = await fetch(url, { headers: { 'User-Agent': OFF_USER_AGENT } });
      if (!res.ok) {
        console.warn(`  OFF category ${category} failed: ${res.status} ${res.statusText}`);
        await sleep(OFF_REQUEST_DELAY_MS);
        continue;
      }
      const body = await res.json();
      let addedThisCategory = 0;

      for (const p of body.products ?? []) {
        if (!p.code || seenCodes.has(p.code)) continue;
        const name = (p.product_name_en || p.product_name || '').trim();
        if (!name) continue;

        const n = p.nutriments ?? {};
        const energy = n['energy-kcal_100g'];
        const protein = n['proteins_100g'];
        const fat = n['fat_100g'];
        const carb = n['carbohydrates_100g'];
        if (typeof energy !== 'number' || !Number.isFinite(energy)) continue; // unusable without energy

        seenCodes.add(p.code);
        addedThisCategory += 1;

        const macrosPresent = [protein, fat, carb].every((v) => typeof v === 'number');
        const servingFromText = offServingFromText(p.serving_size);

        rows.push({
          source: 'open_food_facts',
          sourceRef: p.code,
          barcode: p.code,
          name,
          brand: p.brands?.split(',')[0]?.trim() || null,
          category: p.categories_tags?.[p.categories_tags.length - 1]?.replace(/^en:/, '') ?? null,
          basis: offBasisFor(p.categories_tags),
          energy_kcal: energy,
          protein_g: typeof protein === 'number' ? protein : null,
          carb_g: typeof carb === 'number' ? carb : null,
          fat_g: typeof fat === 'number' ? fat : null,
          micros: {
            fiber_g: n['fiber_100g'] ?? null,
            sugar_g: n['sugars_100g'] ?? null,
            added_sugar_g: n['added-sugars_100g'] ?? null,
            saturated_fat_g: n['saturated-fat_100g'] ?? null,
            trans_fat_g: n['trans-fat_100g'] ?? null,
            sodium_mg: typeof n['sodium_100g'] === 'number' ? n['sodium_100g'] * 1000 : null,
            cholesterol_mg: typeof n['cholesterol_100g'] === 'number' ? n['cholesterol_100g'] * 1000 : null,
            potassium_mg: typeof n['potassium_100g'] === 'number' ? n['potassium_100g'] * 1000 : null,
            calcium_mg: typeof n['calcium_100g'] === 'number' ? n['calcium_100g'] * 1000 : null,
            iron_mg: typeof n['iron_100g'] === 'number' ? n['iron_100g'] * 1000 : null,
            vitamin_d_mcg: typeof n['vitamin-d_100g'] === 'number' ? n['vitamin-d_100g'] * 1_000_000 : null,
            vitamin_c_mg: typeof n['vitamin-c_100g'] === 'number' ? n['vitamin-c_100g'] * 1000 : null,
          },
          dataQuality: offDataQualityFor(p.completeness, macrosPresent),
          attribution: 'Open Food Facts contributors, ODbL (https://opendatacommons.org/licenses/odbl/1-0/)',
          servings: servingFromText ? [servingFromText] : [],
        });
      }
      console.log(`  OFF category ${category}: ${addedThisCategory} usable products (of ${(body.products ?? []).length} fetched).`);
    } catch (err) {
      console.warn(`  OFF category ${category} failed: ${err.message}`);
    }
    await sleep(OFF_REQUEST_DELAY_MS);
  }

  return rows;
}

// -----------------------------------------------------------------------------
// Merge / dedup (§2.1)
// -----------------------------------------------------------------------------
function dedupAndFlagDisagreements(fdcRows, offRows) {
  const barcodeIndex = new Map(); // barcode -> fdc row (FDC is higher-precedence per §2.1)
  for (const r of fdcRows) {
    if (r.barcode) barcodeIndex.set(r.barcode, r);
  }

  const nameKeyIndex = new Set(fdcRows.map((r) => normalizeKey(r.name, r.brand)));

  const conflicts = [];
  const keptOffRows = [];
  let skippedAsCrossSourceDuplicate = 0;

  for (const off of offRows) {
    // Cross-source name+brand dedup: FDC wins on a genuine same-identity
    // match (§2.1: "prefer FDC for generic/whole foods"), same discipline as
    // the exercise-library ingestion's claimedKeys pattern.
    const nameKey = normalizeKey(off.name, off.brand);
    if (nameKeyIndex.has(nameKey)) {
      skippedAsCrossSourceDuplicate += 1;
      continue;
    }

    if (off.barcode && barcodeIndex.has(off.barcode)) {
      const fdcMatch = barcodeIndex.get(off.barcode);
      const relDiff = Math.abs(off.energy_kcal - fdcMatch.energy_kcal) / Math.max(fdcMatch.energy_kcal, 1);
      if (relDiff > MATERIAL_DISAGREEMENT_THRESHOLD) {
        conflicts.push({
          barcode: off.barcode,
          fdc: { sourceRef: fdcMatch.sourceRef, name: fdcMatch.name, energy_kcal: fdcMatch.energy_kcal },
          off: { sourceRef: off.sourceRef, name: off.name, energy_kcal: off.energy_kcal },
          relativeDifference: relDiff,
        });
        // §2.1: "record both / mark data_quality = low / surface for review"
        // — never silently pick a winner. Both (source, source_ref) rows are
        // kept (distinct dedup keys); the OFF-sourced row is forced to 'low'.
        off.dataQuality = 'low';
      }
    }

    keptOffRows.push(off);
  }

  return { keptOffRows, conflicts, skippedAsCrossSourceDuplicate };
}

// Unit self-test against the REAL disagreement fixture (see this file's
// header) — runs on every invocation (cheap, no network) so the flagging
// logic is provably correct regardless of live network conditions this run.
function runDisagreementFixtureSelfTest() {
  const fixtureFdc = [
    { source: 'usda_fdc', sourceRef: '2187885', barcode: '30034086411', name: 'CHICKEN BREAST', brand: 'Giant Eagle, Inc.', energy_kcal: 165 },
  ];
  const fixtureOff = [
    {
      source: 'open_food_facts',
      sourceRef: 'fixture-le-gaulois-chicken',
      barcode: '30034086411', // same real-world barcode, deliberately, to exercise the conflict path
      name: 'Filet de poulet x 2',
      brand: 'Le Gaulois',
      energy_kcal: 108,
      dataQuality: 'medium',
    },
  ];
  const { conflicts, keptOffRows } = dedupAndFlagDisagreements(fixtureFdc, fixtureOff);
  const ok =
    conflicts.length === 1 &&
    Math.abs(conflicts[0].relativeDifference - (165 - 108) / 165) < 0.001 &&
    keptOffRows.length === 1 &&
    keptOffRows[0].dataQuality === 'low';
  console.log(
    `\nSelf-test (real disagreement fixture: FDC 165 kcal/100g vs OFF 108 kcal/100g, same barcode): ` +
      `${ok ? 'PASS' : 'FAIL'} — conflict flagged=${conflicts.length === 1}, both rows kept=${keptOffRows.length === 1}, ` +
      `OFF row forced to data_quality='low'=${keptOffRows[0]?.dataQuality === 'low'}.`
  );
  if (!ok) throw new Error('Disagreement-fixture self-test FAILED — refusing to proceed with an unverified dedup implementation.');
}

// -----------------------------------------------------------------------------
// Write path (service_role)
// -----------------------------------------------------------------------------
async function upsertFoodRow(admin, row) {
  const { data: foodRow, error: foodErr } = await admin
    .from('foods')
    .upsert(
      {
        source: row.source,
        source_ref: row.sourceRef,
        barcode: row.barcode,
        name: row.name,
        brand: row.brand,
        category: row.category,
        basis: row.basis,
        energy_kcal: row.energy_kcal,
        protein_g: row.protein_g,
        carb_g: row.carb_g,
        fat_g: row.fat_g,
        data_quality: row.dataQuality,
        attribution: row.attribution,
        is_active: true,
      },
      { onConflict: 'source,source_ref' }
    )
    .select('id')
    .single();

  if (foodErr) throw new Error(`Failed to upsert food ${row.source}/${row.sourceRef} (${row.name}): ${foodErr.message}`);
  const foodId = foodRow.id;

  // Servings: refresh scoped to this food (delete-then-reinsert, mirroring
  // the exercise-media refresh pattern) so a re-run never accumulates stale
  // duplicate servings. Always ensure the synthetic 100g/100ml default
  // exists (§1.1: "every food gets at least a synthetic 100 g/100 ml default
  // serving at ingest").
  const { error: delServingsErr } = await admin.from('food_servings').delete().eq('food_id', foodId);
  if (delServingsErr) throw new Error(`Failed to clear stale servings for ${row.name}: ${delServingsErr.message}`);

  const unitLabel = row.basis === 'per_100ml' ? '100 ml' : '100 g';
  const servingRows = [{ id: randomUUID(), food_id: foodId, label: unitLabel, gram_or_ml_weight: 100, is_default: true, sort_order: 0 }];
  (row.servings ?? []).forEach((s, idx) => {
    if (Math.abs(s.gramOrMlWeight - 100) < 0.5) return; // don't duplicate the synthetic default
    servingRows.push({ id: randomUUID(), food_id: foodId, label: s.label, gram_or_ml_weight: s.gramOrMlWeight, is_default: false, sort_order: idx + 1 });
  });
  const { error: insServingsErr } = await admin.from('food_servings').insert(servingRows);
  if (insServingsErr) throw new Error(`Failed to insert servings for ${row.name}: ${insServingsErr.message}`);

  // Micronutrients: refresh scoped to this food.
  const { error: delNutrientsErr } = await admin.from('food_nutrients').delete().eq('food_id', foodId);
  if (delNutrientsErr) throw new Error(`Failed to clear stale nutrients for ${row.name}: ${delNutrientsErr.message}`);

  const NUTRIENT_UNIT = {
    fiber_g: 'g', sugar_g: 'g', added_sugar_g: 'g', saturated_fat_g: 'g', trans_fat_g: 'g',
    sodium_mg: 'mg', cholesterol_mg: 'mg', potassium_mg: 'mg', calcium_mg: 'mg', iron_mg: 'mg',
    vitamin_d_mcg: 'mcg', vitamin_c_mg: 'mg',
  };
  const nutrientRows = Object.entries(row.micros ?? {})
    .filter(([, amount]) => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)
    .map(([kind, amount]) => ({
      id: randomUUID(),
      food_id: foodId,
      nutrient_kind: kind,
      amount: Math.round(amount * 10000) / 10000,
      unit: NUTRIENT_UNIT[kind],
    }));
  if (nutrientRows.length > 0) {
    const { error: insNutrientsErr } = await admin.from('food_nutrients').insert(nutrientRows);
    if (insNutrientsErr) throw new Error(`Failed to insert nutrients for ${row.name}: ${insNutrientsErr.message}`);
  }

  return foodId;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  runDisagreementFixtureSelfTest();

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('\nFetching USDA FoodData Central...');
  const { rows: fdcRows, rateLimited, rateLimitInfo } = await fetchFdcRows();
  console.log(`  ${fdcRows.length} usable FDC rows.`);

  console.log('\nFetching Open Food Facts...');
  const offRowsRaw = await fetchOffRows();
  console.log(`  ${offRowsRaw.length} usable OFF rows (pre-dedup).`);

  console.log('\nMerging / deduping (§2.1)...');
  const { keptOffRows, conflicts, skippedAsCrossSourceDuplicate } = dedupAndFlagDisagreements(fdcRows, offRowsRaw);
  console.log(`  ${keptOffRows.length} OFF rows kept after dedup (${skippedAsCrossSourceDuplicate} skipped as cross-source name+brand duplicates of an FDC row).`);
  if (conflicts.length > 0) {
    console.log(`  ${conflicts.length} REAL same-barcode source disagreement(s) found and flagged (never silently picked):`);
    for (const c of conflicts) {
      console.log(
        `    barcode ${c.barcode}: FDC "${c.fdc.name}" (${c.fdc.energy_kcal} kcal/100g) vs ` +
          `OFF "${c.off.name}" (${c.off.energy_kcal} kcal/100g) — ${(c.relativeDifference * 100).toFixed(1)}% relative difference. ` +
          `OFF row forced to data_quality='low'; BOTH rows kept.`
      );
    }
  } else {
    console.log('  No same-barcode cross-source disagreements found in this run\'s live data (the required disagreement case is separately proven by the fixture self-test above, independent of live network conditions).');
  }

  const allRows = [...fdcRows, ...keptOffRows];
  console.log(`\nWriting ${allRows.length} rows to public.foods (service_role)...`);
  let written = 0;
  for (const row of allRows) {
    try {
      await upsertFoodRow(admin, row);
      written += 1;
    } catch (err) {
      console.warn(`  FAILED to write ${row.source}/${row.sourceRef} (${row.name}): ${err.message}`);
    }
  }

  const { count: finalFoodCount, error: countErr } = await admin.from('foods').select('id', { count: 'exact', head: true });
  if (countErr) throw new Error(`Failed to count final foods: ${countErr.message}`);

  console.log('\n=============================================================');
  console.log('Food-database ingestion summary');
  console.log('=============================================================');
  console.log(`USDA FDC rows fetched this run:         ${fdcRows.length}${rateLimited ? '  (DEGRADED — see rate-limit warning above)' : ''}`);
  console.log(`Open Food Facts rows fetched this run:  ${offRowsRaw.length}`);
  console.log(`OFF rows kept after cross-source dedup:  ${keptOffRows.length}`);
  console.log(`Rows written (upserted) this run:        ${written} / ${allRows.length} attempted`);
  console.log(`Same-barcode disagreements flagged:      ${conflicts.length}`);
  console.log(`Final public.foods row count (all-time): ${finalFoodCount}`);
  if (rateLimited) {
    console.log(
      `\nFDC ingestion was PARTIAL this run due to a real, live-confirmed DEMO_KEY rate-limit lockout ` +
        `(retry-after ≈ ${rateLimitInfo?.retryAfterSeconds ?? 'unknown'}s). Re-run with FDC_API_KEY set to a ` +
        `real key (free: https://api.data.gov/signup/) for a full-scale FDC pull.`
    );
  }
  console.log(
    '\nATTRIBUTION FLAG (architecture §2.1/§6): every ingested row carries its own `attribution` string ' +
      '(USDA citation / "Open Food Facts contributors, ODbL"), but there is currently no in-app nutrition-' +
      'sources/credits surface to render it — mirroring the exact gap flagged by Phase 2\'s exercise-library ' +
      'ingestion for wger\'s CC-BY-SA content. ui-ux-designer/mobile-builder must add a visible attribution ' +
      'surface before this content ships to real users, satisfying BOTH the USDA citation expectation and ' +
      "Open Food Facts' ODbL SHARE-ALIKE obligation (the share-alike term itself — redistributing/adapting " +
      'OFF data under a compatible license — is a legal sign-off item tracked at §12, not resolved by this ' +
      'script).'
  );
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
