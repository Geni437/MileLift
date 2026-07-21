#!/usr/bin/env node
/**
 * Live verification script — the Phase 2 gate-critical "airplane mode"
 * scenario, simulated at the RPC/data level: `scripts/verify-save-workout-session.mjs`
 * already verifies `save_workout_session_v1` directly (exact-same-call retry,
 * batched PR detection, tombstone demotion, direct-edit reconciliation). This
 * script goes further and reproduces the actual *client retry shapes*
 * `src/sync/workoutSync.ts#pushWorkoutSave` produces against a real device's
 * offline-queue -> flaky-reconnect flow, per the gate's own wording: "log a
 * full workout in airplane mode, return online, confirm exactly one synced
 * copy exists."
 *
 * Cases NOT covered by the existing script, added here:
 *   1. Retry storm — the identical full multi-exercise payload sent 5x in a
 *      row (a real flaky-reconnect retry loop, not just "twice").
 *   2. Partial-confirmed-then-retry — the realistic "spotty reconnect" case:
 *      some sets are already server_confirmed (and thus NOT resent, per
 *      workoutSessionsRepository.getDirtySets/pushWorkoutSave's own
 *      dirty-only payload), while others are still dirty and are resent,
 *      retried 3x.
 *   3. A set added then immediately tombstoned before ever syncing — tested
 *      at the RPC layer as defense-in-depth (a first-ever appearance of a set
 *      id that already carries `deleted_at`), even though the correct client
 *      behavior (workoutSessionsRepository.removeSet) never sends such a set
 *      to the server at all (see this script's own final report).
 *   4. Stale-resend-after-fresher-edit — models what happens if the client's
 *      sequencing guarantee (RPC §2.6) is ever violated: an older cached
 *      payload for a set completes AFTER a newer edit of the same set has
 *      already landed. Demonstrates the RPC has no data-freshness ordering
 *      safeguard beyond call-arrival order (last-call-wins, not
 *      last-true-edit-wins) — the actual defense is client-side sequencing.
 *   5. Genuine concurrent (Promise.all) overlapping calls across two
 *      sessions racing for the same exercise/metric — reproduces the
 *      RPC doc's own documented "known, accepted, narrow risk" (§2.6) to
 *      show concretely what it looks like when the client's single-in-flight
 *      guarantee is defeated.
 *
 * Standalone, manually-run script (not part of `npm test` / CI) — talks to a
 * REAL Supabase project, not a mock, and mutates real data in a disposable
 * test account it creates and deletes itself. Same convention as
 * scripts/verify-save-workout-session.mjs / verify-pr-achievement-race-fix.mjs:
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

const TEST_EMAIL = `workout-sync-idem-${Date.now()}@example.invalid`;
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

  const { data: squat, error: squatErr } = await admin
    .from('exercises')
    .select('id, slug, primary_muscle, is_weighted, is_bodyweight')
    .eq('slug', 'barbell-back-squat')
    .maybeSingle();
  const { data: bench, error: benchErr } = await admin
    .from('exercises')
    .select('id, slug, primary_muscle, is_weighted, is_bodyweight')
    .eq('slug', 'barbell-bench-press')
    .maybeSingle();
  if (squatErr || !squat || benchErr || !bench) {
    console.error(
      'FAIL: could not find barbell-back-squat / barbell-bench-press in exercises:',
      squatErr?.message ?? benchErr?.message ?? 'not found'
    );
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

    const makeSet = (id, exercise, order, num, reps, weight, extra = {}) => ({
      id,
      exercise_id: exercise.id,
      custom_exercise_id: null,
      exercise_name_snapshot: exercise.slug,
      primary_muscle_snapshot: exercise.primary_muscle,
      exercise_order: order,
      set_number: num,
      set_type: 'working',
      reps,
      weight_kg: weight,
      unit_weight_snapshot: 'kg',
      is_bodyweight: false,
      is_completed: true,
      ...extra,
    });

    async function countSetLogs(sessionId) {
      const { count } = await client
        .from('workout_set_logs')
        .select('id', { count: 'exact', head: true })
        .eq('timeline_event_id', sessionId);
      return count;
    }

    async function countTimelineEvents(sessionId) {
      const { count } = await client
        .from('timeline_events')
        .select('id', { count: 'exact', head: true })
        .eq('id', sessionId);
      return count;
    }

    // =========================================================================
    console.log('\n--- Case 1: retry storm — identical full multi-exercise payload sent 5x in a row ---');
    // =========================================================================
    const s1 = randomUUID();
    const nowIso = new Date().toISOString();
    const localDate = nowIso.slice(0, 10);
    const setIds1 = Array.from({ length: 6 }, () => randomUUID());
    const payload1 = () => ({
      p_id: s1,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 3000,
      p_sets: [
        makeSet(setIds1[0], squat, 0, 1, 5, 100),
        makeSet(setIds1[1], squat, 0, 2, 5, 105),
        makeSet(setIds1[2], squat, 0, 3, 5, 110),
        makeSet(setIds1[3], bench, 1, 1, 8, 60),
        makeSet(setIds1[4], bench, 1, 2, 8, 65),
        makeSet(setIds1[5], bench, 1, 3, 8, 70),
      ],
      p_title: 'Retry Storm Day',
      p_session_rpe: 7,
    });

    const responses1 = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await client.rpc('save_workout_session_v1', payload1());
      check(`retry storm attempt ${attempt}: no transport error`, !res.error, res.error?.message);
      check(`retry storm attempt ${attempt}: no business error`, res.data && !res.data.error, JSON.stringify(res.data?.error));
      responses1.push(res.data?.data);
    }
    check('retry storm: exactly 1 timeline_events row', (await countTimelineEvents(s1)) === 1, await countTimelineEvents(s1));
    check('retry storm: exactly 6 workout_set_logs rows (no duplicates across 5 retries)', (await countSetLogs(s1)) === 6, await countSetLogs(s1));
    check(
      'retry storm: total_sets = 6 on every attempt',
      responses1.every((r) => r?.total_sets === 6),
      JSON.stringify(responses1.map((r) => r?.total_sets))
    );
    const achievementCounts1 = responses1.map((r) => (r?.achievements ?? []).length);
    check(
      'retry storm: achievement count identical across all 5 attempts (no growth on retry)',
      achievementCounts1.every((n) => n === achievementCounts1[0]),
      JSON.stringify(achievementCounts1)
    );

    // =========================================================================
    console.log('\n--- Case 2: partial-confirmed-then-retry ("spotty reconnect") ---');
    // =========================================================================
    // Models the REAL client shape: workoutSessionsRepository.getDirtySets only
    // returns currently-dirty sets, so pushWorkoutSave's p_sets never includes
    // already-server_confirmed, non-dirty sets. First call commits A, B, C.
    // Then (offline) the user edits B and adds D — only B and D are "dirty" —
    // and that partial payload is retried 3x (simulating a flaky reconnect
    // that keeps failing transport-side after the DB write already landed).
    const s2 = randomUUID();
    const [setA, setB, setC, setD] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const initial2 = await client.rpc('save_workout_session_v1', {
      p_id: s2,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 1800,
      p_sets: [makeSet(setA, squat, 0, 1, 5, 80), makeSet(setB, squat, 0, 2, 5, 85), makeSet(setC, squat, 0, 3, 5, 90)],
      p_title: 'Spotty Reconnect Day',
    });
    check('spotty reconnect: initial 3-set save succeeds', initial2.data && !initial2.data.error, JSON.stringify(initial2.data?.error));
    check('spotty reconnect: initial total_sets = 3', initial2.data?.data?.total_sets === 3, initial2.data?.data?.total_sets);

    // Only B (edited) and D (new) are dirty — A and C are NOT included, exactly
    // as the real client's getDirtySets()-scoped p_sets would omit them.
    const partialPayload = () => ({
      p_id: s2,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 1800,
      p_sets: [makeSet(setB, squat, 0, 2, 5, 95 /* edited from 85 -> 95 */), makeSet(setD, squat, 0, 4, 5, 100 /* new */)],
      p_title: 'Spotty Reconnect Day',
    });
    const responses2 = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await client.rpc('save_workout_session_v1', partialPayload());
      check(`spotty reconnect partial retry ${attempt}: no error`, res.data && !res.data.error, JSON.stringify(res.data?.error));
      responses2.push(res.data?.data);
    }
    check(
      'spotty reconnect: total_sets = 4 after partial retries (A, edited-B, C, new-D)',
      responses2.every((r) => r?.total_sets === 4),
      JSON.stringify(responses2.map((r) => r?.total_sets))
    );
    check('spotty reconnect: exactly 4 workout_set_logs rows (D not duplicated across 3 retries)', (await countSetLogs(s2)) === 4, await countSetLogs(s2));

    const { data: setRowsAfter2 } = await client.from('workout_set_logs').select('id, weight_kg').in('id', [setA, setB, setC, setD]);
    const byId2 = new Map(setRowsAfter2.map((r) => [r.id, Number(r.weight_kg)]));
    check('spotty reconnect: set A (never resent) untouched at 80kg', byId2.get(setA) === 80, byId2.get(setA));
    check('spotty reconnect: set C (never resent) untouched at 90kg', byId2.get(setC) === 90, byId2.get(setC));
    check('spotty reconnect: set B correctly updated to 95kg (the resent edit)', byId2.get(setB) === 95, byId2.get(setB));
    check('spotty reconnect: set D correctly created at 100kg exactly once', byId2.get(setD) === 100, byId2.get(setD));

    // =========================================================================
    console.log('\n--- Case 3: set added then immediately tombstoned before ever syncing (fully offline lifecycle) ---');
    // =========================================================================
    // NOTE: the CORRECT client (workoutSessionsRepository.removeSet) checks
    // `serverConfirmed` and hard-deletes locally without ever contacting the
    // server when a set is removed before its first sync — so this exact
    // payload should never actually leave the device. Tested here anyway as
    // defense-in-depth: if a bug ever caused the client to send it, does the
    // RPC handle a set whose FIRST appearance already carries `deleted_at`
    // safely (no crash, no duplicate row, correctly excluded from totals/PRs)?
    const s3 = randomUUID();
    const setNeverSynced = randomUUID();
    const tombstoneOnFirstTouchPayload = () => ({
      p_id: s3,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 600,
      p_sets: [
        { ...makeSet(setNeverSynced, squat, 0, 1, 5, 999 /* would be a huge new PR if ever counted */), deleted_at: new Date().toISOString() },
      ],
      p_title: 'Add-then-tombstone-offline Day',
    });
    const respTomb = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await client.rpc('save_workout_session_v1', tombstoneOnFirstTouchPayload());
      check(`tombstone-on-first-touch attempt ${attempt}: no error`, res.data && !res.data.error, JSON.stringify(res.data?.error));
      respTomb.push(res.data?.data);
    }
    check(
      'tombstone-on-first-touch: total_sets = 0 (never-live set excluded from totals on every attempt)',
      respTomb.every((r) => r?.total_sets === 0),
      JSON.stringify(respTomb.map((r) => r?.total_sets))
    );
    check(
      'tombstone-on-first-touch: no achievement ever logged for a set that was never live',
      respTomb.every((r) => (r?.achievements ?? []).length === 0),
      JSON.stringify(respTomb.map((r) => r?.achievements))
    );
    const { count: tombRowCount } = await client.from('workout_set_logs').select('id', { count: 'exact', head: true }).eq('id', setNeverSynced);
    check('tombstone-on-first-touch: at most 1 row exists for this set id (never duplicated across 3 retries)', tombRowCount <= 1, tombRowCount);
    const { data: recordsAfterTomb } = await client.from('strength_records').select('*').eq('exercise_id', squat.id).eq('metric', 'heaviest_weight').maybeSingle();
    check(
      'tombstone-on-first-touch: strength_records heaviest_weight NOT corrupted to 999 by the never-live set',
      Number(recordsAfterTomb?.value ?? 0) !== 999,
      JSON.stringify(recordsAfterTomb)
    );

    // =========================================================================
    console.log('\n--- Case 4: stale resend arrives AFTER a fresher edit (models a sequencing-guarantee violation) ---');
    // =========================================================================
    const s4 = randomUUID();
    const setX = randomUUID();
    await client.rpc('save_workout_session_v1', {
      p_id: s4,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 900,
      p_sets: [makeSet(setX, squat, 0, 1, 5, 100)],
      p_title: 'Sequencing Risk Day',
    });
    // The "fresher" edit lands first (weight corrected 100 -> 150).
    const freshEdit = await client.rpc('save_workout_session_v1', {
      p_id: s4,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 900,
      p_sets: [makeSet(setX, squat, 0, 1, 5, 150)],
      p_title: 'Sequencing Risk Day',
    });
    check('sequencing risk: fresh edit to 150kg succeeds', freshEdit.data && !freshEdit.data.error, JSON.stringify(freshEdit.data?.error));
    // A STALE resend (the ORIGINAL 100kg payload, representing a delayed retry
    // from an earlier overlapping sync pass that only completes now, after the
    // fresher edit already landed) arrives second.
    const staleResend = await client.rpc('save_workout_session_v1', {
      p_id: s4,
      p_occurred_at: nowIso,
      p_local_date: localDate,
      p_event_timezone: 'UTC',
      p_duration_seconds: 900,
      p_sets: [makeSet(setX, squat, 0, 1, 5, 100)],
      p_title: 'Sequencing Risk Day',
    });
    check('sequencing risk: stale resend itself succeeds (no error)', staleResend.data && !staleResend.data.error, JSON.stringify(staleResend.data?.error));
    const { data: setXFinal } = await client.from('workout_set_logs').select('weight_kg').eq('id', setX).maybeSingle();
    check(
      'sequencing risk (DEMONSTRATED, not a pass/fail on correctness): the RPC has no data-freshness guard — ' +
        'the stale 100kg resend silently overwrote the fresher 150kg edit (last-CALL-wins, not last-EDIT-wins)',
      Number(setXFinal?.weight_kg) === 100,
      `actual weight_kg=${setXFinal?.weight_kg} — if this is 150 instead, the RPC unexpectedly preserved the fresher edit; either way, ` +
        `client-side single-flight sequencing (RPC §2.6) is the ONLY thing preventing this from being reachable in practice`
    );

    // =========================================================================
    console.log('\n--- Case 5: genuine concurrent overlapping calls across two sessions racing for the same PR metric ---');
    // =========================================================================
    // Reproduces RPC doc §2.6's own documented "known, accepted, narrow risk":
    // two truly concurrent save_workout_session_v1 calls for the SAME account
    // can each independently compare against the same stale cache read and
    // both log an achievement for the same metric. The doc's mitigation is
    // client-side strict sequencing (never Promise.all, single in-flight) —
    // this case fires two calls via Promise.all to show what happens if that
    // guarantee is defeated (see this script's report re: the syncEngine.ts
    // `syncing` guard race found during code review).
    const sessionRace1 = randomUUID();
    const sessionRace2 = randomUUID();
    const setRace1 = randomUUID();
    const setRace2 = randomUUID();
    const raceNowIso = new Date().toISOString();
    const [race1, race2] = await Promise.all([
      client.rpc('save_workout_session_v1', {
        p_id: sessionRace1,
        p_occurred_at: raceNowIso,
        p_local_date: localDate,
        p_event_timezone: 'UTC',
        p_duration_seconds: 1200,
        p_sets: [makeSet(setRace1, bench, 0, 1, 3, 200)],
        p_title: 'Concurrent Race Session 1',
      }),
      client.rpc('save_workout_session_v1', {
        p_id: sessionRace2,
        p_occurred_at: raceNowIso,
        p_local_date: localDate,
        p_event_timezone: 'UTC',
        p_duration_seconds: 1200,
        p_sets: [makeSet(setRace2, bench, 0, 1, 3, 205)],
        p_title: 'Concurrent Race Session 2',
      }),
    ]);
    check('concurrent race: call 1 no error', race1.data && !race1.data.error, JSON.stringify(race1.data?.error));
    check('concurrent race: call 2 no error', race2.data && !race2.data.error, JSON.stringify(race2.data?.error));
    const { data: raceAchievements } = await client
      .from('strength_achievements')
      .select('source_set_log_id, metric, value')
      .in('source_set_log_id', [setRace1, setRace2])
      .eq('metric', 'heaviest_weight');
    const { data: raceRecord } = await client.from('strength_records').select('value, source_set_log_id').eq('exercise_id', bench.id).eq('metric', 'heaviest_weight').maybeSingle();
    console.log(
      `  INFO  concurrent race result: achievements logged = ${raceAchievements.length} ` +
        `(${JSON.stringify(raceAchievements)}), final cached record = ${JSON.stringify(raceRecord)}`
    );
    check(
      'concurrent race: strength_records cache converges to the TRUE final winner (205kg) regardless of achievement-count outcome',
      Number(raceRecord?.value) === 205,
      JSON.stringify(raceRecord)
    );
    if (raceAchievements.length > 1) {
      console.log(
        '  INFO  >1 heaviest_weight achievement rows were logged for this single race — this IS the documented ' +
          '§2.6 "known, accepted, narrow risk" reproduced live. Not counted as a failure here (it is explicitly ' +
          'accepted in the RPC contract), but it is real evidence that this outcome is reachable, not theoretical.'
      );
    }
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
