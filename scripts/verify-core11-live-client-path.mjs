#!/usr/bin/env node
/**
 * CORE-11 gate, exercised through the REAL Module A client path (not a
 * simulated spine row).
 *
 * `scripts/verify-food-log-and-reconciliation-rpcs.mjs` Case 5 proves
 * `get_daily_energy_balance_v1`'s aggregation math is correct GIVEN a
 * gps_activity/strength_session row that already carries a populated,
 * negative `energy_kcal` — but it creates that row with a direct
 * `service_role` insert into `timeline_events`, standing in for
 * `save_activity_v1`/`save_workout_session_v1`. It never calls those RPCs
 * themselves, so it cannot catch a gap in what the REAL mobile client
 * actually sends them.
 *
 * `src/features/activity/useRecordingEngine.ts`'s `confirmSave` — the ONLY
 * code path that saves a GPS activity recorded through the live app — always
 * sends `energyKcal: null, caloriesSource: 'none'` (see that file's own
 * comment: "No calorie estimation is implemented in Phase 1 mobile ...
 * Flagged as follow-up"). `src/features/activity/useActivityDetail.ts`'s
 * `editActivity` never touches those fields either (title/description edit
 * only) — there is NO code path in the shipped app that ever sends a
 * non-null `p_energy_kcal` to `save_activity_v1` for a Module A activity.
 * The identical gap exists on the Module C side: no screen ever calls
 * `workoutSessionsRepository.updateMeta({ caloriesSource, energyKcal })`
 * with a non-'none' source before a session's own push.
 *
 * This script calls `save_activity_v1` (the REAL RPC the client calls, not
 * an admin insert) with EXACTLY the payload shape `confirmSave` sends for a
 * real, no-consent, non-wearable recorded run, then asserts what
 * `get_daily_energy_balance_v1` shows for that day — proving concretely
 * whether "log a workout in Module A [through the real app], confirm the
 * calorie-burn figure appears correctly in Module B" actually holds today.
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
  console.error('FAIL: SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set in the environment.');
  process.exit(1);
}

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
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const stamp = Date.now();
  const TEST_EMAIL = `core11-client-path-verify-${stamp}@example.invalid`;
  const PASSWORD = randomUUID() + 'Aa1!';

  console.log('Bootstrapping disposable test user...');
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: TEST_EMAIL, password: PASSWORD, email_confirm: true });
  if (createErr) {
    console.error('FAIL: could not create disposable test user:', createErr.message);
    process.exit(1);
  }
  const userId = created.user.id;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { error: signInErr } = await client.auth.signInWithPassword({ email: TEST_EMAIL, password: PASSWORD });
    if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);

    const testDate = '2026-07-23';
    const occurredAt = new Date(`${testDate}T06:00:00Z`).toISOString();

    // =========================================================================
    console.log('\n--- Step 1: save_activity_v1 with the EXACT payload the real client sends ---');
    console.log('    (src/features/activity/useRecordingEngine.ts confirmSave: energyKcal: null, caloriesSource: \'none\')');
    // =========================================================================
    const activityId = randomUUID();
    const realClientSave = await client.rpc('save_activity_v1', {
      p_id: activityId,
      p_activity_type_code: 'run',
      p_occurred_at: occurredAt,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 1800, // 30 min, matches a real no-GPS-declined-or-indoor run shape
      p_source: 'manual',
      p_visibility: 'private',
      // The exact fields useRecordingEngine.ts's confirmSave sends today —
      // no calorie estimation exists client-side (Phase 1 flagged gap).
      p_energy_kcal: null,
      p_calories_source: 'none',
      p_distance_m: 5000,
      p_unit_distance_snapshot: 'km',
      p_moving_time_seconds: 1750,
    });
    check('save_activity_v1: the real client payload is accepted (no transport/business error)', !realClientSave.error && !realClientSave.data?.error, realClientSave.error?.message ?? realClientSave.data);
    check('save_activity_v1: response echoes energy_kcal = null (nothing was estimated)', realClientSave.data?.data?.energy_kcal === null, realClientSave.data?.data);

    // =========================================================================
    console.log('\n--- Step 2: get_daily_energy_balance_v1 — does the workout show up? ---');
    // =========================================================================
    const balanceAfterRealActivity = await client.rpc('get_daily_energy_balance_v1', { p_local_date: testDate });
    check('get_daily_energy_balance_v1: no transport/business error', !balanceAfterRealActivity.error && !balanceAfterRealActivity.data?.error, balanceAfterRealActivity.data);
    const b1 = balanceAfterRealActivity.data?.data;
    const events1 = b1?.expenditure_events ?? [];

    // THE ACTUAL GATE QUESTION: does a real, just-logged Module A activity's
    // burn appear in Module B's daily balance? As shipped, it does NOT — the
    // checks below are written to the CORRECT/expected behavior (the gate's
    // literal wording), so a FAIL here is the real, reproducible gap, not a
    // test-authoring mistake.
    check(
      'GATE: the just-logged Module A run appears in expenditure_events',
      events1.some((e) => e.timeline_event_id === activityId),
      { expected_to_contain: activityId, actual_events: events1 }
    );
    check(
      'GATE: calories_out_kcal reflects the just-logged run (> 0)',
      Number(b1?.calories_out_kcal) > 0,
      b1
    );

    // =========================================================================
    console.log('\n--- Step 3: isolate the fault — is the RPC/aggregate broken, or only the client payload? ---');
    console.log('    (edit the SAME activity via save_activity_v1 with a populated energy_kcal, as a');
    console.log('     wearable-sourced or future estimated-calories client theoretically would)');
    // =========================================================================
    const editedSave = await client.rpc('save_activity_v1', {
      p_id: activityId,
      p_activity_type_code: 'run',
      p_occurred_at: occurredAt,
      p_local_date: testDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 1800,
      p_source: 'manual',
      p_visibility: 'private',
      p_energy_kcal: -350,
      p_calories_source: 'estimated',
      p_distance_m: 5000,
      p_unit_distance_snapshot: 'km',
      p_moving_time_seconds: 1750,
    });
    check('save_activity_v1: editing the same activity with a populated energy_kcal succeeds', !editedSave.error && !editedSave.data?.error, editedSave.error?.message ?? editedSave.data);
    check('save_activity_v1: response now echoes energy_kcal = -350', closeEnough(Number(editedSave.data?.data?.energy_kcal), -350), editedSave.data?.data);

    const balanceAfterEdit = await client.rpc('get_daily_energy_balance_v1', { p_local_date: testDate });
    const b2 = balanceAfterEdit.data?.data;
    const events2 = b2?.expenditure_events ?? [];
    check(
      'CONTROL: once energy_kcal is populated (any source), the SAME RPC pipeline shows it correctly',
      events2.some((e) => e.timeline_event_id === activityId) && closeEnough(Number(b2?.calories_out_kcal), 350),
      { expected_calories_out: 350, actual: b2 }
    );
  } finally {
    console.log('\nCleaning up disposable test user...');
    await admin.auth.admin.deleteUser(userId);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) {
    console.log(
      '\nIf the two GATE checks in Step 2 failed while the CONTROL check in Step 3 passed: this\n' +
        'confirms get_daily_energy_balance_v1 itself is correct, but the real Module A client\n' +
        '(src/features/activity/useRecordingEngine.ts confirmSave) never populates energy_kcal for a\n' +
        "recorded activity, so a real user's tracked run currently shows ZERO calorie burn in\n" +
        'Module B — the CORE-11 gate\'s literal scenario does not hold end-to-end through the shipped\n' +
        'client, even though the backend RPC-level reconciliation logic is correct.'
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: uncaught error:', err);
  process.exit(1);
});
