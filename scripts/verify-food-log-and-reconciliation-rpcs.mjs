#!/usr/bin/env node
/**
 * Live verification script for Phase 3 Module B's backend-builder RPCs:
 *   - save_food_log_entry_v1   (supabase/migrations/20260722200000_create_save_food_log_entry_rpc.sql)
 *   - log_saved_meal_v1        (supabase/migrations/20260722200100_create_log_saved_meal_rpc.sql)
 *   - save_water_intake_v1 / save_manual_burn_v1
 *                              (supabase/migrations/20260722200200_create_save_water_and_manual_burn_rpcs.sql)
 *   - get_daily_energy_balance_v1 / get_daily_macros_v1
 *                              (supabase/migrations/20260722200300_create_daily_energy_and_macros_rpcs.sql)
 *
 * Standalone, manually-run script (not part of `npm test` / CI) — talks to a
 * REAL Supabase project, not a mock, and mutates real data in a disposable
 * test account it creates and deletes itself. Mirrors the established
 * convention (scripts/verify-save-workout-session.mjs,
 * scripts/verify-nutrition-schema.mjs):
 *   - service_role is used ONLY to bootstrap (create the disposable user),
 *     simulate Module A/C spine rows directly (the same shortcut
 *     verify-nutrition-schema.mjs uses to simulate cross-module timeline
 *     rows without needing Module A/C's own save RPCs), and clean up (delete
 *     the user) — every RPC call under test goes through the ANON client
 *     signed in as that user, under RLS, exactly as the mobile app would.
 *
 * THE CORE-11 GATE TEST (explicit task requirement): "log a workout in
 * Module A, confirm the calorie-burn figure appears correctly in Module B
 * without double-counting." Simulated here by inserting one gps_activity-like
 * and one strength_session-like timeline_events row directly (standing in
 * for Module A/C's own save_activity_v1/save_workout_session_v1, which this
 * script does not depend on), then asserting get_daily_energy_balance_v1
 * counts each exactly once alongside a real food_log_entry and a real
 * manual_calorie_burn on the same day.
 *
 * Required environment variables (never hardcoded, never committed):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'FAIL: SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set ' +
      'in the environment. Refusing to guess/hardcode credentials.'
  );
  process.exit(1);
}

// Seeded reference foods from 20260722100300_seed_reference_foods.sql.
const CHICKEN_BREAST_ID = 'a0000000-0000-4000-8000-000000000001'; // per_100g: 165 kcal, 31.0 protein, 0.0 carb, 3.6 fat
const BANANA_ID = 'a0000000-0000-4000-8000-000000000004'; // per_100g: 89 kcal, 1.1 protein, 22.8 carb, 0.3 fat

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function closeEnough(a, b, eps = 0.01) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < eps;
}

async function main() {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = Date.now();
  const TEST_EMAIL = `food-log-rpc-verify-${stamp}@example.invalid`;
  const OTHER_EMAIL = `food-log-rpc-verify-other-${stamp}@example.invalid`;
  const PASSWORD = randomUUID() + 'Aa1!';

  console.log(`Bootstrapping disposable test users...`);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  const { data: createdOther, error: createOtherErr } = await admin.auth.admin.createUser({
    email: OTHER_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createErr || createOtherErr) {
    console.error('FAIL: could not create disposable test users:', createErr?.message, createOtherErr?.message);
    process.exit(1);
  }
  const userId = created.user.id;
  const otherUserId = createdOther.user.id;

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const otherClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { error: signInErr } = await client.auth.signInWithPassword({ email: TEST_EMAIL, password: PASSWORD });
    const { error: signInOtherErr } = await otherClient.auth.signInWithPassword({ email: OTHER_EMAIL, password: PASSWORD });
    if (signInErr || signInOtherErr) throw new Error(`sign-in failed: ${signInErr?.message} / ${signInOtherErr?.message}`);

    const testDate = '2026-07-22';
    const nowIso = new Date(`${testDate}T12:00:00Z`).toISOString();

    // =========================================================================
    console.log('\n--- Case 1: save_food_log_entry_v1 (transactional meal + items) ---');
    // =========================================================================
    const mealId = randomUUID();
    const chickenItemId = randomUUID();
    const bananaItemId = randomUUID();

    // 150g chicken breast: 165*1.5 = 247.5 kcal, 31*1.5=46.5 protein, 0 carb, 3.6*1.5=5.4 fat.
    // 1 banana (118g serving * qty 1): 89*1.18=105.02 kcal, 1.1*1.18=1.298 protein, 22.8*1.18=26.904 carb, 0.3*1.18=0.354 fat.
    const saveMeal1 = await client.rpc('save_food_log_entry_v1', {
      p_id: mealId,
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_meal_type: 'lunch',
      p_title: 'RPC Verify Lunch',
      p_items: [
        {
          id: chickenItemId,
          food_id: CHICKEN_BREAST_ID,
          food_name_snapshot: 'Chicken Breast, Cooked, Skinless',
          serving_label_snapshot: '150 g',
          quantity: 1.5,
          serving_g_or_ml_snapshot: 100,
          energy_kcal: 247.5,
          protein_g: 46.5,
          carb_g: 0,
          fat_g: 5.4,
          data_quality_snapshot: 'high',
          sort_order: 0,
        },
        {
          id: bananaItemId,
          food_id: BANANA_ID,
          food_name_snapshot: 'Banana, Raw',
          serving_label_snapshot: '1 medium banana (118 g)',
          quantity: 1,
          serving_g_or_ml_snapshot: 118,
          energy_kcal: 105.02,
          protein_g: 1.298,
          carb_g: 26.904,
          fat_g: 0.354,
          data_quality_snapshot: 'high',
          sort_order: 1,
        },
      ],
    });
    check('save_food_log_entry_v1: no transport error', !saveMeal1.error, saveMeal1.error?.message);
    check('save_food_log_entry_v1: no business error', saveMeal1.data && !saveMeal1.data.error, saveMeal1.data);
    const meal1Data = saveMeal1.data?.data;
    check('save_food_log_entry_v1: item_count = 2', meal1Data?.item_count === 2, meal1Data);
    check(
      'save_food_log_entry_v1: total_energy_kcal = sum of items (247.5 + 105.02)',
      closeEnough(Number(meal1Data?.total_energy_kcal), 352.52),
      meal1Data
    );
    check(
      'save_food_log_entry_v1: total_protein_g = sum of items (46.5 + 1.298)',
      closeEnough(Number(meal1Data?.total_protein_g), 47.798),
      meal1Data
    );

    // Idempotent retry of the exact same call must not double the totals.
    const saveMeal1Retry = await client.rpc('save_food_log_entry_v1', {
      p_id: mealId,
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_meal_type: 'lunch',
      p_title: 'RPC Verify Lunch',
      p_items: [
        {
          id: chickenItemId,
          food_id: CHICKEN_BREAST_ID,
          food_name_snapshot: 'Chicken Breast, Cooked, Skinless',
          serving_label_snapshot: '150 g',
          quantity: 1.5,
          serving_g_or_ml_snapshot: 100,
          energy_kcal: 247.5,
          protein_g: 46.5,
          carb_g: 0,
          fat_g: 5.4,
          sort_order: 0,
        },
      ],
    });
    check('save_food_log_entry_v1: retry (partial payload) succeeds, no duplication', !saveMeal1Retry.error && !saveMeal1Retry.data?.error, saveMeal1Retry);
    check(
      'save_food_log_entry_v1: retry leaves total_energy_kcal unchanged (untouched item not re-validated/duplicated)',
      closeEnough(Number(saveMeal1Retry.data?.data?.total_energy_kcal), 352.52),
      saveMeal1Retry.data
    );

    // Remove the banana item via explicit tombstone (never omission, §9).
    const removeBanana = await client.rpc('save_food_log_entry_v1', {
      p_id: mealId,
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_meal_type: 'lunch',
      p_items: [
        {
          id: bananaItemId,
          food_id: BANANA_ID,
          food_name_snapshot: 'Banana, Raw',
          serving_label_snapshot: '1 medium banana (118 g)',
          quantity: 1,
          serving_g_or_ml_snapshot: 118,
          energy_kcal: 105.02,
          sort_order: 1,
          deleted_at: new Date().toISOString(),
        },
      ],
    });
    check('save_food_log_entry_v1: explicit item tombstone succeeds', !removeBanana.error && !removeBanana.data?.error, removeBanana);
    check(
      'save_food_log_entry_v1: total_energy_kcal recomputed after tombstone (chicken only, 247.5)',
      closeEnough(Number(removeBanana.data?.data?.total_energy_kcal), 247.5),
      removeBanana.data
    );

    // Validation: both food_id and custom_food_id set -> INVALID_FOOD_REF.
    const invalidRef = await client.rpc('save_food_log_entry_v1', {
      p_id: randomUUID(),
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_meal_type: 'snack',
      p_items: [
        {
          id: randomUUID(),
          food_id: CHICKEN_BREAST_ID,
          custom_food_id: randomUUID(),
          food_name_snapshot: 'x',
          serving_label_snapshot: 'x',
          quantity: 1,
          serving_g_or_ml_snapshot: 100,
          energy_kcal: 1,
          sort_order: 0,
        },
      ],
    });
    check('save_food_log_entry_v1: both food_id+custom_food_id -> INVALID_FOOD_REF', invalidRef.data?.error?.code === 'INVALID_FOOD_REF', invalidRef.data);

    // Cross-user isolation: the other user cannot read this meal.
    const otherReadMeal = await otherClient.from('food_log_entries').select('timeline_event_id').eq('timeline_event_id', mealId);
    check("food_log_entries: other user cannot see this user's meal", (otherReadMeal.data ?? []).length === 0, otherReadMeal.data);

    // =========================================================================
    console.log('\n--- Case 2: log_saved_meal_v1 (expand a live plan, resolve CURRENT macros) ---');
    // =========================================================================
    const savedMealId = randomUUID();
    const insSavedMeal = await client.from('saved_meals').insert({
      id: savedMealId,
      user_id: userId,
      name: 'RPC Verify Saved Breakfast',
      meal_type: 'breakfast',
    });
    check('saved_meals: insert succeeds', !insSavedMeal.error, insSavedMeal.error?.message);

    const insSavedItem = await client.from('saved_meal_items').insert({
      id: randomUUID(),
      saved_meal_id: savedMealId,
      user_id: userId,
      food_id: BANANA_ID,
      serving_label: '1 medium banana (118 g)',
      serving_g_or_ml: 118,
      quantity: 2, // 2 bananas
      sort_order: 0,
    });
    check('saved_meal_items: insert succeeds', !insSavedItem.error, insSavedItem.error?.message);

    const loggedMealId = randomUUID();
    const logSavedMeal = await client.rpc('log_saved_meal_v1', {
      p_id: loggedMealId,
      p_saved_meal_id: savedMealId,
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
    });
    check('log_saved_meal_v1: no transport error', !logSavedMeal.error, logSavedMeal.error?.message);
    check('log_saved_meal_v1: no business error', logSavedMeal.data && !logSavedMeal.data.error, logSavedMeal.data);
    // 2 bananas * 118g each = 236g -> 89 * 2.36 = 210.04 kcal.
    check(
      'log_saved_meal_v1: resolves CURRENT banana macros (2 servings, 210.04 kcal)',
      closeEnough(Number(logSavedMeal.data?.data?.total_energy_kcal), 210.04),
      logSavedMeal.data
    );
    check("log_saved_meal_v1: meal_type falls back to the saved meal's own meal_type (breakfast)", logSavedMeal.data?.data?.meal_type === 'breakfast', logSavedMeal.data);

    // Idempotent replay: same p_id must return the SAME data, not double-log.
    const logSavedMealReplay = await client.rpc('log_saved_meal_v1', {
      p_id: loggedMealId,
      p_saved_meal_id: savedMealId,
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
    });
    check('log_saved_meal_v1: replay with same p_id succeeds', !logSavedMealReplay.error && !logSavedMealReplay.data?.error, logSavedMealReplay.data);
    check('log_saved_meal_v1: replay is flagged replayed=true', logSavedMealReplay.data?.data?.replayed === true, logSavedMealReplay.data);
    const { data: itemsAfterReplay } = await client.from('food_log_items').select('id').eq('timeline_event_id', loggedMealId);
    check('log_saved_meal_v1: replay did NOT create duplicate items (still exactly 1)', (itemsAfterReplay ?? []).length === 1, itemsAfterReplay);

    // =========================================================================
    console.log('\n--- Case 3: save_water_intake_v1 ---');
    // =========================================================================
    const waterId = randomUUID();
    const saveWater = await client.rpc('save_water_intake_v1', {
      p_id: waterId,
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_volume_ml: 500,
      p_unit_volume_snapshot: 'ml',
    });
    check('save_water_intake_v1: succeeds', !saveWater.error && !saveWater.data?.error, saveWater.data);

    const saveWaterBadVolume = await client.rpc('save_water_intake_v1', {
      p_id: randomUUID(),
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_volume_ml: -1,
      p_unit_volume_snapshot: 'ml',
    });
    check('save_water_intake_v1: negative volume_ml -> NEGATIVE_MEASUREMENT', saveWaterBadVolume.data?.error?.code === 'NEGATIVE_MEASUREMENT', saveWaterBadVolume.data);

    // =========================================================================
    console.log('\n--- Case 4: save_manual_burn_v1 + the CORE-11 overlap advisory (§4.3) ---');
    // =========================================================================
    // Simulate a Module A GPS run already on the spine (negative energy),
    // 18:00-18:45 UTC.
    const gpsRunId = randomUUID();
    const gpsOccurredAt = new Date(`${testDate}T18:00:00Z`).toISOString();
    const insGpsRun = await admin.from('timeline_events').insert({
      id: gpsRunId,
      user_id: userId,
      source_module: 'activity',
      event_type: 'gps_activity',
      occurred_at: gpsOccurredAt,
      local_date: testDate,
      event_timezone: 'UTC',
      energy_kcal: -450,
      duration_seconds: 2700, // 45 minutes
      source: 'manual',
    });
    check('(simulated Module A) gps_activity spine row insert succeeds', !insGpsRun.error, insGpsRun.error?.message);

    // Manual burn logged for an OVERLAPPING window (18:15-18:30) -> advisory should fire.
    const overlappingBurnId = randomUUID();
    const overlappingBurn = await client.rpc('save_manual_burn_v1', {
      p_id: overlappingBurnId,
      p_occurred_at: new Date(`${testDate}T18:15:00Z`).toISOString(),
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_energy_kcal: -120,
      p_label: 'Yoga (accidentally overlapping the tracked run)',
      p_duration_minutes: 15,
    });
    check('save_manual_burn_v1: overlapping burn still SAVES (never blocked, §12 decision 2)', !overlappingBurn.error && !overlappingBurn.data?.error, overlappingBurn.data);
    check(
      'save_manual_burn_v1: overlap_advisory.has_overlap = true for an overlapping window',
      overlappingBurn.data?.data?.overlap_advisory?.has_overlap === true,
      overlappingBurn.data
    );
    check(
      'save_manual_burn_v1: overlap_advisory names the gps_activity row',
      (overlappingBurn.data?.data?.overlap_advisory?.overlapping_events ?? []).some((e) => e.timeline_event_id === gpsRunId),
      overlappingBurn.data?.data?.overlap_advisory
    );

    // Manual burn logged for a NON-overlapping window (a different time entirely) -> no advisory.
    const nonOverlappingBurnId = randomUUID();
    const nonOverlappingBurn = await client.rpc('save_manual_burn_v1', {
      p_id: nonOverlappingBurnId,
      p_occurred_at: new Date(`${testDate}T09:00:00Z`).toISOString(),
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_energy_kcal: -180,
      p_label: 'Tennis',
      p_duration_minutes: 60,
    });
    check('save_manual_burn_v1: non-overlapping burn succeeds', !nonOverlappingBurn.error && !nonOverlappingBurn.data?.error, nonOverlappingBurn.data);
    check(
      'save_manual_burn_v1: overlap_advisory.has_overlap = false for a non-overlapping window',
      nonOverlappingBurn.data?.data?.overlap_advisory?.has_overlap === false,
      nonOverlappingBurn.data
    );

    // Consent gate: estimated energy_source without health consent -> rejected.
    const estimatedNoConsent = await client.rpc('save_manual_burn_v1', {
      p_id: randomUUID(),
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_energy_kcal: -100,
      p_label: 'Estimated burn without consent',
      p_energy_source: 'estimated',
    });
    check(
      'save_manual_burn_v1: energy_source=estimated WITHOUT health consent -> CONSENT_REQUIRED_HEALTH',
      estimatedNoConsent.data?.error?.code === 'CONSENT_REQUIRED_HEALTH',
      estimatedNoConsent.data
    );

    // Positive/non-negative energy_kcal is rejected outright (must be < 0).
    const positiveBurn = await client.rpc('save_manual_burn_v1', {
      p_id: randomUUID(),
      p_occurred_at: nowIso,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_energy_kcal: 100,
      p_label: 'Should be rejected',
    });
    check('save_manual_burn_v1: energy_kcal >= 0 -> INVALID_ENERGY_SIGN', positiveBurn.data?.error?.code === 'INVALID_ENERGY_SIGN', positiveBurn.data);

    // =========================================================================
    console.log('\n--- Case 5: THE CORE-11 GATE TEST — get_daily_energy_balance_v1 ---');
    console.log('    ("log a workout in Module A, confirm the calorie-burn figure');
    console.log('     appears correctly in Module B without double-counting")');
    // =========================================================================
    // Simulate a Module C strength session already on the spine (negative energy).
    const strengthSessionId = randomUUID();
    const insStrength = await admin.from('timeline_events').insert({
      id: strengthSessionId,
      user_id: userId,
      source_module: 'strength',
      event_type: 'strength_session',
      occurred_at: new Date(`${testDate}T07:00:00Z`).toISOString(),
      local_date: testDate,
      event_timezone: 'UTC',
      energy_kcal: -300,
      duration_seconds: 3000,
      source: 'manual',
    });
    check('(simulated Module C) strength_session spine row insert succeeds', !insStrength.error, insStrength.error?.message);

    const balance = await client.rpc('get_daily_energy_balance_v1', { p_local_date: testDate });
    check('get_daily_energy_balance_v1: no transport error', !balance.error, balance.error?.message);
    check('get_daily_energy_balance_v1: no business error', balance.data && !balance.data.error, balance.data);

    const b = balance.data?.data;
    // Intake for the day: 247.5 (chicken-only meal) + 210.04 (2 bananas from saved meal) = 457.54
    const expectedCaloriesIn = 247.5 + 210.04;
    // Expenditure for the day: gps_activity(-450) + strength_session(-300) + overlapping burn(-120) + non-overlapping burn(-180) = -1050
    const expectedCaloriesOut = 450 + 300 + 120 + 180;
    check(
      `get_daily_energy_balance_v1: calories_in_kcal = ${expectedCaloriesIn} (food only, exactly once)`,
      closeEnough(Number(b?.calories_in_kcal), expectedCaloriesIn),
      b
    );
    check(
      `get_daily_energy_balance_v1: calories_out_kcal = ${expectedCaloriesOut} (gps_activity + strength_session + both manual burns, ADDITIVE, each counted EXACTLY ONCE)`,
      closeEnough(Number(b?.calories_out_kcal), expectedCaloriesOut),
      b
    );
    check(
      'get_daily_energy_balance_v1: net_kcal = calories_in - calories_out',
      closeEnough(Number(b?.net_kcal), expectedCaloriesIn - expectedCaloriesOut),
      b
    );
    const expenditureEvents = b?.expenditure_events ?? [];
    check('get_daily_energy_balance_v1: expenditure_events includes the gps_activity row exactly once', expenditureEvents.filter((e) => e.timeline_event_id === gpsRunId).length === 1, expenditureEvents);
    check('get_daily_energy_balance_v1: expenditure_events includes the strength_session row exactly once', expenditureEvents.filter((e) => e.timeline_event_id === strengthSessionId).length === 1, expenditureEvents);
    check('get_daily_energy_balance_v1: expenditure_events includes both manual burns exactly once each', expenditureEvents.filter((e) => e.timeline_event_id === overlappingBurnId).length === 1 && expenditureEvents.filter((e) => e.timeline_event_id === nonOverlappingBurnId).length === 1, expenditureEvents);
    check('get_daily_energy_balance_v1: the gps_activity line item carries no manual-burn label', expenditureEvents.find((e) => e.timeline_event_id === gpsRunId)?.label == null, expenditureEvents);
    check('get_daily_energy_balance_v1: the manual burn line item carries its label', expenditureEvents.find((e) => e.timeline_event_id === overlappingBurnId)?.label != null, expenditureEvents);

    // Cross-user isolation on the aggregate: other user's balance must be unaffected/empty for this date.
    const otherBalance = await otherClient.rpc('get_daily_energy_balance_v1', { p_local_date: testDate });
    check(
      "get_daily_energy_balance_v1: other user's balance for this date is zero (RLS-scoped aggregate)",
      Number(otherBalance.data?.data?.calories_in_kcal) === 0 && Number(otherBalance.data?.data?.calories_out_kcal) === 0,
      otherBalance.data
    );

    // =========================================================================
    console.log('\n--- Case 6: get_daily_macros_v1 ---');
    // =========================================================================
    const macros = await client.rpc('get_daily_macros_v1', { p_local_date: testDate });
    check('get_daily_macros_v1: no transport error', !macros.error, macros.error?.message);
    check('get_daily_macros_v1: no business error', macros.data && !macros.data.error, macros.data);
    check(
      `get_daily_macros_v1: total_energy_kcal = ${expectedCaloriesIn} (matches get_daily_energy_balance_v1's calories_in)`,
      closeEnough(Number(macros.data?.data?.total_energy_kcal), expectedCaloriesIn),
      macros.data
    );
    check('get_daily_macros_v1: meal_count = 2 (the lunch + the logged saved meal)', macros.data?.data?.meal_count === 2, macros.data);
    check('get_daily_macros_v1: water_ml_total = 500', Number(macros.data?.data?.water_ml_total) === 500, macros.data);
  } finally {
    console.log('\nCleaning up disposable test users...');
    await admin.auth.admin.deleteUser(userId);
    await admin.auth.admin.deleteUser(otherUserId);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: uncaught error:', err);
  process.exit(1);
});
