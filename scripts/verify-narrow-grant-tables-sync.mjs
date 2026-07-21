#!/usr/bin/env node
/**
 * Live verification script — the six push paths in `src/sync/workoutSync.ts`
 * that code-reviewer and security-auditor independently flagged as
 * release-blocking: `pushCustomExercises`, `pushWorkoutTemplates` (both the
 * template row AND its `workout_template_exercises` child rows),
 * `pushPrograms` (both the program row AND its `program_workouts` child
 * rows), and `pushBodyMeasurements`'s `body_measurement_values` child-row
 * push. Every one of these tables has a column-scoped `grant update (...)`
 * narrower than a naive `.upsert()` payload, and none of the existing live
 * scripts (`verify-save-workout-session.mjs`,
 * `verify-workout-sync-idempotency.mjs`, `verify-pr-achievement-race-fix.mjs`)
 * cover these tables at all — which is exactly why this shipped once already.
 *
 * Each table gets TWO checks:
 *   1. A REGRESSION DEMONSTRATION — the exact naive whole-row `.upsert()`
 *      shape the buggy code used, proven to fail with a `42501` permission
 *      error on the very FIRST insert of a new row (not just on a later
 *      edit) — concrete evidence the original bug was real, not
 *      theoretical.
 *   2. The FIX verification — the actual `insert()`-then-`update()` shape
 *      `src/sync/workoutSync.ts` now uses, proven to succeed for both a
 *      first create AND a subsequent edit, with the correctly-scoped
 *      payload landing intact.
 *
 * Standalone, manually-run script (not part of `npm test` / CI) — talks to a
 * REAL Supabase project, not a mock, and mutates real data in a disposable
 * test account it creates and deletes itself. Same convention as
 * scripts/verify-save-workout-session.mjs / verify-workout-sync-idempotency.mjs:
 *   - service_role is used ONLY to bootstrap (create the disposable user) and
 *     clean up (delete it) — every table write/read below goes through the
 *     ANON client signed in as that user, under RLS, exactly as the mobile
 *     app would.
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

const TEST_EMAIL = `narrow-grant-sync-${Date.now()}@example.invalid`;
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

/** True only for a genuine Postgres permission-denied-for-column error (42501), the plan-time failure this whole bug class produces. */
function isPermissionDenied(error) {
  return error?.code === '42501';
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
    .select('id, slug')
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
    const { error: signInErr } = await client.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
    if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);

    // =========================================================================
    console.log('\n--- custom_exercises ---');
    // =========================================================================
    {
      const regressionId = randomUUID();
      const { error: upsertErr } = await client.from('custom_exercises').upsert(
        { id: regressionId, user_id: userId, name: 'Regression Demo Curl', is_weighted: true, is_bodyweight: false, is_time_based: false, is_distance_based: false },
        { onConflict: 'id' }
      );
      check(
        'REGRESSION: naive whole-row upsert on a brand-new row fails with 42501 (user_id in SET clause, not grant-covered)',
        isPermissionDenied(upsertErr),
        JSON.stringify(upsertErr)
      );

      const fixId = randomUUID();
      const { error: insertErr } = await client
        .from('custom_exercises')
        .insert({ id: fixId, user_id: userId, name: 'Fixed Curl', is_weighted: true, is_bodyweight: false, is_time_based: false, is_distance_based: false });
      check('FIX: plain insert (first create) succeeds', !insertErr, insertErr?.message);

      const { error: updateErr } = await client.from('custom_exercises').update({ name: 'Fixed Curl (renamed)' }).eq('id', fixId);
      check('FIX: column-scoped update (edit) succeeds', !updateErr, updateErr?.message);

      const { data: finalRow } = await client.from('custom_exercises').select('name').eq('id', fixId).maybeSingle();
      check('FIX: edit landed correctly', finalRow?.name === 'Fixed Curl (renamed)', finalRow?.name);
    }

    // =========================================================================
    console.log('\n--- workout_templates + workout_template_exercises ---');
    // =========================================================================
    let fixedTemplateId;
    {
      const regressionId = randomUUID();
      const { error: upsertErr } = await client.from('workout_templates').upsert({ id: regressionId, user_id: userId, name: 'Regression Demo Template' }, { onConflict: 'id' });
      check('REGRESSION: workout_templates naive upsert on a brand-new row fails with 42501', isPermissionDenied(upsertErr), JSON.stringify(upsertErr));

      fixedTemplateId = randomUUID();
      const { error: insertErr } = await client.from('workout_templates').insert({ id: fixedTemplateId, user_id: userId, name: 'Push Day' });
      check('FIX: workout_templates plain insert (first create) succeeds', !insertErr, insertErr?.message);

      const { error: updateErr } = await client.from('workout_templates').update({ name: 'Push Day (renamed)' }).eq('id', fixedTemplateId);
      check('FIX: workout_templates column-scoped update (edit) succeeds', !updateErr, updateErr?.message);

      const { data: finalRow } = await client.from('workout_templates').select('name').eq('id', fixedTemplateId).maybeSingle();
      check('FIX: workout_templates edit landed correctly', finalRow?.name === 'Push Day (renamed)', finalRow?.name);

      // ---- child rows: workout_template_exercises ----
      const regressionExId = randomUUID();
      const { error: exUpsertErr } = await client.from('workout_template_exercises').upsert(
        { id: regressionExId, template_id: fixedTemplateId, user_id: userId, exercise_id: squat.id, custom_exercise_id: null, exercise_order: 0, target_sets: 3 },
        { onConflict: 'id' }
      );
      check(
        'REGRESSION: workout_template_exercises naive upsert fails with 42501 (exercise_id/user_id excluded from UPDATE grant)',
        isPermissionDenied(exUpsertErr),
        JSON.stringify(exUpsertErr)
      );

      const fixedExId = randomUUID();
      const { error: exInsertErr } = await client
        .from('workout_template_exercises')
        .insert({ id: fixedExId, template_id: fixedTemplateId, user_id: userId, exercise_id: squat.id, custom_exercise_id: null, exercise_order: 0, target_sets: 3, target_reps_low: 8, target_reps_high: 12 });
      check('FIX: workout_template_exercises plain insert (first create) succeeds', !exInsertErr, exInsertErr?.message);

      const { error: exUpdateErr } = await client.from('workout_template_exercises').update({ target_sets: 4 }).eq('id', fixedExId);
      check('FIX: workout_template_exercises column-scoped update (edit) succeeds', !exUpdateErr, exUpdateErr?.message);

      const { data: finalExRow } = await client.from('workout_template_exercises').select('target_sets').eq('id', fixedExId).maybeSingle();
      check('FIX: workout_template_exercises edit landed correctly', finalExRow?.target_sets === 4, finalExRow?.target_sets);
    }

    // =========================================================================
    console.log('\n--- programs + program_workouts ---');
    // =========================================================================
    {
      const regressionId = randomUUID();
      const { error: upsertErr } = await client.from('programs').upsert({ id: regressionId, user_id: userId, name: 'Regression Demo Program' }, { onConflict: 'id' });
      check('REGRESSION: programs naive upsert on a brand-new row fails with 42501', isPermissionDenied(upsertErr), JSON.stringify(upsertErr));

      const fixedProgramId = randomUUID();
      const { error: insertErr } = await client.from('programs').insert({ id: fixedProgramId, user_id: userId, name: 'PPL 6-day', length_weeks: 8 });
      check('FIX: programs plain insert (first create) succeeds', !insertErr, insertErr?.message);

      const { error: updateErr } = await client.from('programs').update({ name: 'PPL 6-day (renamed)' }).eq('id', fixedProgramId);
      check('FIX: programs column-scoped update (edit) succeeds', !updateErr, updateErr?.message);

      const { data: finalRow } = await client.from('programs').select('name').eq('id', fixedProgramId).maybeSingle();
      check('FIX: programs edit landed correctly', finalRow?.name === 'PPL 6-day (renamed)', finalRow?.name);

      // ---- child rows: program_workouts ----
      const regressionWId = randomUUID();
      const { error: wUpsertErr } = await client.from('program_workouts').upsert(
        { id: regressionWId, program_id: fixedProgramId, user_id: userId, template_id: fixedTemplateId, week_number: 1, day_number: 1, sort_order: 0 },
        { onConflict: 'id' }
      );
      check(
        'REGRESSION: program_workouts naive upsert fails with 42501 (template_id/user_id excluded from UPDATE grant)',
        isPermissionDenied(wUpsertErr),
        JSON.stringify(wUpsertErr)
      );

      const fixedWId = randomUUID();
      const { error: wInsertErr } = await client
        .from('program_workouts')
        .insert({ id: fixedWId, program_id: fixedProgramId, user_id: userId, template_id: fixedTemplateId, week_number: 1, day_number: 1, sort_order: 0 });
      check('FIX: program_workouts plain insert (first create) succeeds', !wInsertErr, wInsertErr?.message);

      const { error: wUpdateErr } = await client.from('program_workouts').update({ sort_order: 1 }).eq('id', fixedWId);
      check('FIX: program_workouts column-scoped update (edit) succeeds', !wUpdateErr, wUpdateErr?.message);

      const { data: finalWRow } = await client.from('program_workouts').select('sort_order').eq('id', fixedWId).maybeSingle();
      check('FIX: program_workouts edit landed correctly', finalWRow?.sort_order === 1, finalWRow?.sort_order);
    }

    // =========================================================================
    console.log('\n--- body_measurements / body_measurement_values ---');
    // =========================================================================
    {
      // Grant health consent first (the same trigger-enforced precondition
      // pushBodyMeasurements/pushBodyweightLogs already handle) — inserted
      // via the anon client under RLS, exactly as the app's own consent flow does.
      const { error: consentErr } = await client.from('user_consents').insert({ id: randomUUID(), user_id: userId, category: 'health', purpose_version: 'v1' });
      check('setup: health consent grant succeeds', !consentErr, consentErr?.message);

      const occasionId = randomUUID();
      const nowIso = new Date().toISOString();
      const localDate = nowIso.slice(0, 10);
      const { error: spineErr } = await client
        .from('timeline_events')
        .insert({ id: occasionId, user_id: userId, source_module: 'strength', event_type: 'body_measurement', occurred_at: nowIso, local_date: localDate, event_timezone: 'UTC', source: 'manual', visibility: 'private' });
      check('setup: body_measurement spine (timeline_events) insert succeeds', !spineErr, spineErr?.message);

      const { error: occasionErr } = await client.from('body_measurements').insert({ timeline_event_id: occasionId, user_id: userId, notes: null });
      check('setup: body_measurements occasion insert succeeds', !occasionErr, occasionErr?.message);

      // REGRESSION: the exact buggy shape — user_id is in the payload but NOT
      // part of the (timeline_event_id, measurement_kind) onConflict target,
      // so PostgREST's generated ON CONFLICT DO UPDATE SET references it —
      // a column body_measurement_values' grant never covers.
      const { error: valueUpsertErr } = await client.from('body_measurement_values').upsert(
        { timeline_event_id: occasionId, user_id: userId, measurement_kind: 'waist', value: 80, unit_snapshot: 'cm' },
        { onConflict: 'timeline_event_id,measurement_kind' }
      );
      check(
        'REGRESSION: body_measurement_values naive upsert fails with 42501 (user_id not in onConflict target, but in SET clause)',
        isPermissionDenied(valueUpsertErr),
        JSON.stringify(valueUpsertErr)
      );

      // FIX: plain insert for the first write of this (occasion, kind) pair.
      const { error: valueInsertErr } = await client
        .from('body_measurement_values')
        .insert({ timeline_event_id: occasionId, user_id: userId, measurement_kind: 'waist', value: 81, unit_snapshot: 'cm' });
      check('FIX: body_measurement_values plain insert (first write) succeeds', !valueInsertErr, valueInsertErr?.message);

      // FIX: a retried "insert" of the SAME (occasion, kind) pair now hits
      // 23505 (unique_violation on the natural key) — the exact signal
      // pushBodyMeasurements uses to fall through to a column-scoped update.
      const { error: retryInsertErr } = await client
        .from('body_measurement_values')
        .insert({ timeline_event_id: occasionId, user_id: userId, measurement_kind: 'waist', value: 999, unit_snapshot: 'cm' });
      check('FIX: retried insert of the same (occasion, kind) correctly hits 23505 unique_violation', retryInsertErr?.code === '23505', JSON.stringify(retryInsertErr));

      const { error: valueUpdateErr } = await client
        .from('body_measurement_values')
        .update({ value: 82, unit_snapshot: 'cm' })
        .eq('timeline_event_id', occasionId)
        .eq('measurement_kind', 'waist');
      check('FIX: body_measurement_values column-scoped update (edit-after-23505 fallthrough) succeeds', !valueUpdateErr, valueUpdateErr?.message);

      const { data: finalValueRow } = await client.from('body_measurement_values').select('value').eq('timeline_event_id', occasionId).eq('measurement_kind', 'waist').maybeSingle();
      check('FIX: body_measurement_values edit landed correctly at 82 (not 999 from the failed duplicate insert)', Number(finalValueRow?.value) === 82, finalValueRow?.value);
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
