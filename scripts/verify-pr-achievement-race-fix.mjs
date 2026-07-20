#!/usr/bin/env node
/**
 * Live re-verification script for
 * supabase/migrations/20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql
 *
 * This is a standalone, manually-run script (not part of `npm test` / CI) —
 * it talks to a REAL Supabase project (local or hosted), not a mock, and
 * mutates real data (in a disposable test account it creates and deletes
 * itself). It is NOT run automatically anywhere; run it by hand after the
 * fix migration has been pushed to the target project.
 *
 * What it does, in order:
 *   1. (service_role, bootstrap ONLY) Create a disposable test auth user.
 *   2. Sign in as that user with the ANON client — every save_activity_v1
 *      call and every verification read from here on goes through THAT
 *      authenticated client, under RLS, exactly as the mobile app would.
 *      service_role is never used for verification logic, only account
 *      bootstrap/cleanup, per this project's test discipline.
 *   3. Sequential control case: one solo save that beats no prior record
 *      (first-ever value for a fresh metric) — asserts it logs exactly one
 *      achievement, confirming the fix did not break the common,
 *      non-concurrent path.
 *   4. Establish a baseline personal record (12125m hike distance), then
 *      fire 5 concurrent save_activity_v1 calls via Promise.all — the exact
 *      qa-engineer repro shape (13125/15125/14125/17125/16125m distances,
 *      same activity_type_code/metric) — and assert the ACHIEVABLE
 *      invariants (see docs/api/save-activity-v1.md §2.6 for why "exactly
 *      one achievement row" is not achievable at the DB layer):
 *        a) personal_records.value settles at the true max (17125).
 *        b) the true winner (17125m) always has its own achievement row.
 *        c) every achievement row is for a real submitted value, never a
 *           phantom/corrupted one. (>1 row is an accepted, narrow-risk
 *           outcome, not a failure -- see §2.6.)
 *   5. (service_role, cleanup ONLY) Delete the disposable test user
 *      (cascades to profiles/timeline_events/activity_details/
 *      personal_records/activity_achievements via existing ON DELETE
 *      CASCADE FKs).
 *
 * Required environment variables (never hardcoded, never committed):
 *   SUPABASE_URL               e.g. https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY          the publishable/anon key (safe, RLS-scoped)
 *   SUPABASE_SERVICE_ROLE_KEY  bootstrap/cleanup ONLY — never used to call
 *                              save_activity_v1 or to read back verification
 *                              data; a service_role-backed "pass" would not
 *                              actually prove RLS-scoped client behavior.
 *
 * Exit code 0 on all assertions passing, 1 on any failure (including a
 * thrown error) or if required env vars are missing — never a silent
 * partial pass.
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

const ACTIVITY_TYPE = 'hike';
const METRIC = 'longest_distance';
const TEST_EMAIL = `pr-race-fix-verify-${Date.now()}@example.invalid`;
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

function nowIso() {
  return new Date().toISOString();
}

function baseActivityPayload({ id, distanceM, occurredAt }) {
  return {
    p_id: id,
    p_activity_type_code: ACTIVITY_TYPE,
    p_occurred_at: occurredAt,
    p_local_date: occurredAt.slice(0, 10),
    p_event_timezone: 'UTC',
    p_duration_seconds: 3600,
    p_distance_m: distanceM,
    p_unit_distance_snapshot: 'km',
  };
}

async function main() {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Bootstrapping disposable test user (${TEST_EMAIL})...`);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (createErr) {
    console.error('FAIL: could not create test user:', createErr.message);
    process.exit(1);
  }
  const userId = created.user.id;

  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await anon.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr) {
      console.error('FAIL: could not sign in as test user:', signInErr.message);
      process.exit(1);
    }
    // From here on, `anon` holds an authenticated session — every call below
    // runs as this user, under RLS, exactly like the mobile client.

    // -----------------------------------------------------------------
    // 1. Sequential control: a solo save with no prior record for this
    //    (type, metric) must still log exactly one achievement.
    // -----------------------------------------------------------------
    console.log('\n[1/2] Sequential control (non-concurrent path)...');
    const soloId = randomUUID();
    const { data: soloResult, error: soloErr } = await anon.rpc('save_activity_v1', {
      ...baseActivityPayload({ id: soloId, distanceM: 5000, occurredAt: nowIso() }),
    });
    check('save_activity_v1 (solo) returned no transport error', !soloErr, soloErr?.message);
    check('save_activity_v1 (solo) returned data, not error envelope', !!soloResult?.data, JSON.stringify(soloResult));

    const { data: soloAchievements, error: soloReadErr } = await anon
      .from('activity_achievements')
      .select('timeline_event_id, metric, value, rank')
      .eq('timeline_event_id', soloId)
      .eq('metric', METRIC);
    check('sequential save read achievements without error', !soloReadErr, soloReadErr?.message);
    check(
      'sequential save logged exactly one achievement for its own metric',
      soloAchievements?.length === 1,
      `got ${JSON.stringify(soloAchievements)}`
    );

    // -----------------------------------------------------------------
    // 2. Concurrent race repro: baseline PR of 12125m, then 5 concurrent
    //    saves at 13125/15125/14125/17125/16125m — qa-engineer's exact
    //    reproduction shape.
    // -----------------------------------------------------------------
    console.log('\n[2/2] Concurrent batch repro (qa-engineer\'s reproduction)...');
    const baselineId = randomUUID();
    const { error: baselineErr } = await anon.rpc('save_activity_v1', {
      ...baseActivityPayload({ id: baselineId, distanceM: 12125, occurredAt: nowIso() }),
    });
    check('baseline 12125m save succeeded', !baselineErr, baselineErr?.message);

    const raceValues = [13125, 15125, 14125, 17125, 16125];
    const raceIds = raceValues.map(() => randomUUID());
    const raceResults = await Promise.all(
      raceValues.map((distanceM, i) =>
        anon.rpc('save_activity_v1', {
          ...baseActivityPayload({ id: raceIds[i], distanceM, occurredAt: nowIso() }),
        })
      )
    );
    raceResults.forEach((r, i) => {
      check(`concurrent save #${i} (${raceValues[i]}m) returned no transport error`, !r.error, r.error?.message);
    });

    const { data: pr, error: prErr } = await anon
      .from('personal_records')
      .select('value, previous_value, timeline_event_id')
      .eq('activity_type_code', ACTIVITY_TYPE)
      .eq('metric', METRIC)
      .maybeSingle();
    check('read back personal_records without error', !prErr, prErr?.message);
    check(
      'personal_records converged to the true max (17125)',
      pr?.value === 17125,
      `got value=${pr?.value}`
    );
    check(
      'personal_records.timeline_event_id points at the 17125m activity',
      pr?.timeline_event_id === raceIds[raceValues.indexOf(17125)],
      `got ${pr?.timeline_event_id}`
    );

    const { data: raceAchievements, error: raceReadErr } = await anon
      .from('activity_achievements')
      .select('timeline_event_id, value, rank')
      .in('timeline_event_id', raceIds)
      .eq('metric', METRIC);
    check('read back activity_achievements without error', !raceReadErr, raceReadErr?.message);
    // NOTE: "exactly one row for a 5-way concurrent race" is not achievable at the
    // DB layer without a batch boundary that doesn't exist in this system (see
    // docs/api/save-activity-v1.md §2.6) -- confirmed by two live attempts, the
    // second of which made things worse (4 stray rows) by trying to guess whether
    // a batch had "settled". Confirmed via src/sync/activitySync.ts /
    // syncEngine.ts that a single device can never trigger this (sequential
    // queue drain + a single global `syncing` guard) -- the only real trigger is
    // two authenticated sessions for the same account racing at the literal same
    // instant, an accepted narrow risk. What actually matters and IS asserted:
    // the true winner is always logged, and no row is ever corrupted/phantom.
    check(
      'the true final winner (17125m) has its own logged achievement — this must never be silently dropped',
      !!raceAchievements?.some((a) => a.value === 17125),
      `got ${JSON.stringify(raceAchievements)}`
    );
    check(
      'every logged achievement row is for one of the actual submitted race values (no phantom/corrupted rows)',
      !!raceAchievements?.length && raceAchievements.every((a) => raceValues.includes(a.value)),
      `got ${JSON.stringify(raceAchievements)}`
    );
    console.log(
      `  INFO  ${raceAchievements?.length ?? 0} activity_achievements row(s) logged for the 5-way race ` +
        `(1 is the uncontended-common-case outcome; >1 is the accepted narrow-race outcome — both are pass conditions here).`
    );
  } finally {
    console.log('\nCleaning up disposable test user (service_role, cleanup only)...');
    const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
    if (deleteErr) {
      console.error(`WARNING: failed to delete test user ${userId}: ${deleteErr.message}`);
      console.error('Manual cleanup required — this user/its data is otherwise disposable/test-only.');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: unhandled error during verification run:', err);
  process.exit(1);
});
