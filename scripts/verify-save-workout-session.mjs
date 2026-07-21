#!/usr/bin/env node
/**
 * Live verification script for save_workout_session_v1 / the strength PR
 * detection machinery / get_exercise_progression_v1 / get_muscle_volume_v1
 * (supabase/migrations/20260721110000_create_workout_save_and_pr_rpcs.sql,
 * 20260721110100_create_strength_analytics_rpcs.sql).
 *
 * Standalone, manually-run script (not part of `npm test` / CI) — talks to a
 * REAL Supabase project, not a mock, and mutates real data in a disposable
 * test account it creates and deletes itself. Mirrors the existing
 * scripts/verify-pr-achievement-race-fix.mjs convention:
 *   - service_role is used ONLY to bootstrap (create the disposable user) and
 *     clean up (delete it) — every save_workout_session_v1 call and every
 *     verification read goes through the ANON client signed in as that user,
 *     under RLS, exactly as the mobile app would.
 *
 * Required environment variables (never hardcoded, never committed):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *
 * Exit code 0 on all assertions passing, 1 on any failure.
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

const TEST_EMAIL = `save-workout-verify-${Date.now()}@example.invalid`;
const TEST_PASSWORD = randomUUID() + 'Aa1!';

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Bootstrapping disposable test user ${TEST_EMAIL}...`);
  const { data: createdUser, error: createErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (createErr) {
    console.error('FAIL: could not create disposable test user:', createErr.message);
    process.exit(1);
  }
  const userId = createdUser.user.id;

  // A real library exercise from db-engineer's illustrative seed / the real
  // ingestion (barbell-back-squat should exist either way — the ingestion
  // script supersedes the seed row in place, same slug).
  const { data: squat, error: squatErr } = await admin
    .from('exercises')
    .select('id, slug, primary_muscle, is_weighted, is_bodyweight')
    .eq('slug', 'barbell-back-squat')
    .maybeSingle();
  if (squatErr || !squat) {
    console.error('FAIL: could not find barbell-back-squat in exercises:', squatErr?.message ?? 'not found');
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }

  let client;
  try {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await client.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);

    console.log('\n--- Case 1: fresh session, 2 sets, first-ever PRs ---');
    const sessionId = randomUUID();
    const set1Id = randomUUID();
    const set2Id = randomUUID();
    const nowIso = new Date().toISOString();
    const localDate = nowIso.slice(0, 10);

    const makeSet = (id, order, num, reps, weight) => ({
      id,
      exercise_id: squat.id,
      custom_exercise_id: null,
      exercise_name_snapshot: 'Barbell Back Squat',
      primary_muscle_snapshot: squat.primary_muscle,
      exercise_order: order,
      set_number: num,
      set_type: 'working',
      reps,
      weight_kg: weight,
      unit_weight_snapshot: 'kg',
      is_bodyweight: false,
      is_completed: true,
    });

    const call1 = await client.rpc('save_workout_session_v1', {
      p_id: sessionId,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 2400,
      p_sets: [makeSet(set1Id, 0, 1, 5, 100), makeSet(set2Id, 0, 2, 5, 105)],
      p_title: 'Verification Leg Day',
      p_session_rpe: 8,
    });

    check('call 1: no transport error', !call1.error, call1.error?.message);
    const r1 = call1.data;
    check('call 1: no business error', r1 && !r1.error, JSON.stringify(r1?.error));
    check('call 1: total_sets = 2', r1?.data?.total_sets === 2, JSON.stringify(r1?.data));
    check('call 1: total_volume_kg = 5*100 + 5*105 = 1025', Number(r1?.data?.total_volume_kg) === 1025, r1?.data?.total_volume_kg);
    check('call 1: load_score = 8 * (2400/60) = 320', Number(r1?.data?.load_score) === 320, r1?.data?.load_score);
    const achievements1 = r1?.data?.achievements ?? [];
    check(
      'call 1: logs exactly ONE achievement per metric (batched per-exercise-per-call detection, not per-set) — heaviest_weight/estimated_1rm/best_set_volume, all attributed to the 105kg set',
      achievements1.length === 3 &&
        achievements1.every((a) => a.source_set_log_id === set2Id) &&
        achievements1.find((a) => a.metric === 'heaviest_weight')?.value === 105,
      JSON.stringify(achievements1)
    );

    const { data: sr1 } = await client
      .from('strength_records')
      .select('metric, value, previous_value')
      .eq('exercise_id', squat.id);
    const heaviest1 = sr1.find((r) => r.metric === 'heaviest_weight');
    check('strength_records: heaviest_weight = 105', Number(heaviest1?.value) === 105, JSON.stringify(heaviest1));
    check('strength_records: heaviest_weight previous_value is null (first-ever)', heaviest1?.previous_value === null, heaviest1?.previous_value);

    console.log('\n--- Case 2: retry the EXACT same call (idempotency, §9.2) ---');
    const call1Retry = await client.rpc('save_workout_session_v1', {
      p_id: sessionId,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 2400,
      p_sets: [makeSet(set1Id, 0, 1, 5, 100), makeSet(set2Id, 0, 2, 5, 105)],
      p_title: 'Verification Leg Day',
      p_session_rpe: 8,
    });
    check('retry: no transport error', !call1Retry.error, call1Retry.error?.message);
    check('retry: no business error', call1Retry.data && !call1Retry.data.error, JSON.stringify(call1Retry.data?.error));
    check('retry: total_sets still 2 (no duplicate rows)', call1Retry.data?.data?.total_sets === 2, call1Retry.data?.data?.total_sets);
    check(
      'retry: achievements list unchanged in size (idempotent, ON CONFLICT DO NOTHING)',
      (call1Retry.data?.data?.achievements ?? []).length === 3,
      JSON.stringify(call1Retry.data?.data?.achievements)
    );

    const { count: setCountAfterRetry } = await client
      .from('workout_set_logs')
      .select('id', { count: 'exact', head: true })
      .eq('timeline_event_id', sessionId);
    check('retry: exactly 2 workout_set_logs rows exist for this session', setCountAfterRetry === 2, setCountAfterRetry);

    console.log('\n--- Case 3: append a 3rd set that beats the cached PR ---');
    const set3Id = randomUUID();
    const call2 = await client.rpc('save_workout_session_v1', {
      p_id: sessionId,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 2400,
      p_sets: [makeSet(set3Id, 0, 3, 3, 110)],
      p_title: 'Verification Leg Day',
      p_session_rpe: 8,
    });
    check('call 2: no business error', call2.data && !call2.data.error, JSON.stringify(call2.data?.error));
    check('call 2: total_sets = 3 (append-only, prior sets untouched)', call2.data?.data?.total_sets === 3, call2.data?.data?.total_sets);
    const achievements2 = call2.data?.data?.achievements ?? [];
    // achievements is the FULL immutable history for this session across every
    // call so far (mirrors save-activity-v1.md §2.3's semantics) — both the
    // 105kg (call 1) and 110kg (call 2) heaviest_weight rows are real,
    // historical facts and both legitimately remain in the list.
    const newHeaviest = achievements2.find((a) => a.metric === 'heaviest_weight' && a.source_set_log_id === set3Id);
    check('call 2: new heaviest_weight achievement logged for the 110kg set', !!newHeaviest && Number(newHeaviest.value) === 110, JSON.stringify(achievements2));

    const { data: sr2 } = await client
      .from('strength_records')
      .select('metric, value, previous_value')
      .eq('exercise_id', squat.id)
      .eq('metric', 'heaviest_weight')
      .maybeSingle();
    check('strength_records: heaviest_weight now 110', Number(sr2?.value) === 110, JSON.stringify(sr2));
    check('strength_records: previous_value now 105', Number(sr2?.previous_value) === 105, JSON.stringify(sr2));

    console.log('\n--- Case 4: explicit tombstone (soft-delete) of the record-holding set demotes correctly ---');
    const call3 = await client.rpc('save_workout_session_v1', {
      p_id: sessionId,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 2400,
      p_sets: [
        { ...makeSet(set3Id, 0, 3, 3, 110), deleted_at: new Date().toISOString() },
      ],
      p_title: 'Verification Leg Day',
      p_session_rpe: 8,
    });
    check('call 3: no business error', call3.data && !call3.data.error, JSON.stringify(call3.data?.error));
    check('call 3: total_sets back to 2 (tombstoned set excluded)', call3.data?.data?.total_sets === 2, call3.data?.data?.total_sets);

    const { data: sr3 } = await client
      .from('strength_records')
      .select('metric, value, source_set_log_id')
      .eq('exercise_id', squat.id)
      .eq('metric', 'heaviest_weight')
      .maybeSingle();
    check(
      'strength_records: heaviest_weight demoted back to 105 after tombstoning the 110kg set (AFTER UPDATE trigger)',
      Number(sr3?.value) === 105 && sr3?.source_set_log_id === set2Id,
      JSON.stringify(sr3)
    );

    console.log('\n--- Case 5: direct-PostgREST edit of a record-holding set also reconciles (bypasses the RPC) ---');
    // Directly demote set2 (currently the 105kg record holder) via a plain
    // column-scoped UPDATE, exactly the path db-engineer's grant permits.
    const { error: directEditErr } = await client
      .from('workout_set_logs')
      .update({ weight_kg: 50 })
      .eq('id', set2Id);
    check('direct edit: no error (within the granted mutable column set)', !directEditErr, directEditErr?.message);

    const { data: sr4 } = await client
      .from('strength_records')
      .select('value, source_set_log_id')
      .eq('exercise_id', squat.id)
      .eq('metric', 'heaviest_weight')
      .maybeSingle();
    check(
      'strength_records: heaviest_weight recomputed to 100 (set1) after direct-editing the holder down',
      Number(sr4?.value) === 100 && sr4?.source_set_log_id === set1Id,
      JSON.stringify(sr4)
    );

    console.log('\n--- Case 6: validation rejects a negative weight ---');
    const badSessionId = randomUUID();
    const callBad = await client.rpc('save_workout_session_v1', {
      p_id: badSessionId,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 1200,
      p_sets: [makeSet(randomUUID(), 0, 1, 5, -10)],
    });
    check(
      'validation: negative weight_kg rejected with NEGATIVE_MEASUREMENT',
      callBad.data?.error?.code === 'NEGATIVE_MEASUREMENT',
      JSON.stringify(callBad.data)
    );
    const { count: badSessionCount } = await client
      .from('timeline_events')
      .select('id', { count: 'exact', head: true })
      .eq('id', badSessionId);
    check('validation failure: no partial write (timeline_events row never created)', badSessionCount === 0, badSessionCount);

    console.log('\n--- Case 7: analytics RPCs ---');
    const progression = await client.rpc('get_exercise_progression_v1', { p_exercise_id: squat.id });
    check('get_exercise_progression_v1: no error', progression.data && !progression.data.error, JSON.stringify(progression.data?.error));
    check('get_exercise_progression_v1: one session row', (progression.data?.data ?? []).length === 1, JSON.stringify(progression.data?.data));
    check(
      'get_exercise_progression_v1: best_weight_kg reflects post-edit state (100)',
      Number(progression.data?.data?.[0]?.best_weight_kg) === 100,
      JSON.stringify(progression.data?.data)
    );

    const muscleVolume = await client.rpc('get_muscle_volume_v1', {});
    check('get_muscle_volume_v1: no error', muscleVolume.data && !muscleVolume.data.error, JSON.stringify(muscleVolume.data?.error));
    const quadRow = (muscleVolume.data?.data ?? []).find((r) => r.primary_muscle === 'quadriceps');
    check('get_muscle_volume_v1: quadriceps volume entry present', !!quadRow, JSON.stringify(muscleVolume.data?.data));

    console.log('\n--- Case 8: recompute_strength_records_for_user_v1 backfill runs cleanly ---');
    const recompute = await client.rpc('recompute_strength_records_for_user_v1', {});
    check('recompute: no error', recompute.data && !recompute.data.error, JSON.stringify(recompute.data?.error));
    check('recompute: metrics_recomputed > 0', (recompute.data?.data?.metrics_recomputed ?? 0) > 0, JSON.stringify(recompute.data?.data));
  } finally {
    console.log('\nCleaning up disposable test user...');
    await admin.auth.admin.deleteUser(userId);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: uncaught error:', err);
  process.exit(1);
});
