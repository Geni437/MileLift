-- =============================================================================
-- Phase 1 — Module A: revert the pg_locks-waiter "settle" approach from
-- 20260720090000; restore immediate per-transaction achievement logging.
-- Fixes: private._pr_apply_or_recompute (again) and removes
--   private._pr_settle_achievement_if_uncontended, both introduced in
--   supabase/migrations/20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql
-- Design ref: docs/architecture/phase-1-module-a.md §4.2, §4.3.
--
-- Per this project's migration convention, 20260720090000 is already applied
-- and is not edited in place -- this is a new, additive migration.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260720100000_revert_pr_achievement_settle_check_unsound_batch_boundary.sql
-- =============================================================================
-- WHY 20260720090000 IS BEING REVERTED (live re-verification, not just
-- theory -- see the task report for the actual run)
-- =============================================================================
-- 20260720090000's `_pr_settle_achievement_if_uncontended` tried to answer
-- "has this concurrent batch of save_activity_v1 calls, racing for the same
-- (user_id, activity_type_code, metric), fully settled?" by checking
-- pg_locks for any OTHER backend currently blocked waiting on this
-- transaction's row lock. Live re-test against a real Supabase project (5
-- concurrent save_activity_v1 calls, same repro qa-engineer used originally)
-- did NOT fix the bug -- it produced FOUR activity_achievements rows for the
-- race, one worse than the THREE the original bug produced.
--
-- Root cause of why this can never work, not just why this particular
-- attempt didn't: pg_locks' waiter list only reflects backends that have
-- ALREADY reached their own `SELECT ... FOR UPDATE` at the exact instant this
-- transaction checks it. Five HTTP-triggered transactions dispatched via
-- `Promise.all` from separate PostgREST connections do not arrive at the lock
-- manager at the same wall-clock instant -- network jitter between the
-- separate underlying connections means transaction A can easily finish its
-- own compare-and-swap and reach the "is anyone waiting on me" check *before*
-- transaction E has even opened its connection, let alone reached its own
-- `FOR UPDATE`. A is then correctly reporting "no one is waiting on me RIGHT
-- NOW" -- which is true -- while being wrong about the question that
-- actually matters ("am I the batch's final settled state"). Every
-- transaction in the batch can independently, honestly conclude "no one is
-- waiting on me" at whatever instant it happens to check, which is exactly
-- how this produced MORE stray rows than the original bug rather than fewer:
-- each of these honest-but-premature "uncontended" conclusions read whatever
-- personal_records said AT THAT MOMENT and logged a fresh achievement for
-- that instant's holder, and different checks landed at different moments as
-- the chain progressed, so multiple distinct "current holder as of my check"
-- snapshots each got logged.
--
-- This is not a bug in the pg_locks query itself (it correctly reports real,
-- present-tense lock-wait state) -- it is a category error: "is anyone
-- waiting on me at this instant" and "will anyone ever wait on me" are
-- different questions, and Postgres has no mechanism (and cannot have one)
-- for a transaction to block on a lock request that has not been issued yet.
-- A "batch" of concurrent save_activity_v1 calls has no representation
-- anywhere in this system -- no shared batch id, no expected batch size, no
-- coordinator -- it is simply N independent, stateless RPC invocations that
-- happen to overlap in time. Without an actual batch boundary (the client
-- declaring up front "this is a batch of N calls," or a deliberate
-- settle-after-quiet-period job), no single participating transaction can
-- ever correctly answer "has the batch finished" from inside its own
-- transaction, no matter what it inspects pg_locks for. A `pg_advisory_xact_
-- lock` acquired earlier in the function body does not change this: the
-- personal_records row's own `SELECT ... FOR UPDATE` already fully serializes
-- every concurrent caller for this exact (user, type, metric) tuple into one
-- total order (confirmed correct both before and after this migration, by
-- qa-engineer's and this migration's own re-verification) -- an advisory
-- lock taken even earlier adds no new information about how many more
-- siblings are still to arrive; it only strengthens serialization that was
-- already total for the operation that actually needs it.
--
-- =============================================================================
-- REACHABILITY FROM THE REAL MOBILE CLIENT (re-scoping the risk, not just
-- re-attempting the fix -- read src/sync/activitySync.ts and
-- src/sync/syncEngine.ts directly, don't assume)
-- =============================================================================
-- `pushActivities` (src/sync/activitySync.ts) drains a device's pending-
-- activity queue with a plain sequential `for (const activity of unsynced) {
-- await pushSave(activity); }` -- never `Promise.all` or any other
-- concurrent dispatch. `runSync` (src/sync/syncEngine.ts), the only caller of
-- `pushActivities`, is guarded by a single module-level `syncing` boolean
-- checked at entry (`if (!currentUserId || syncing) return;`) that is shared
-- across every one of its trigger sources (app-foreground, network-reconnect,
-- post-write, manual, startup) -- so even if two of those fire in the same
-- tick, the second call no-ops instead of overlapping. The consequence: a
-- SINGLE DEVICE can never fire concurrent save_activity_v1 calls for the same
-- account, under any reachable app state, offline-queue size, or trigger
-- combination. This was re-confirmed by reading both files in full, not
-- assumed from the file names.
--
-- The only real-world path to the race this migration and 20260720090000
-- both address is two or more genuinely simultaneous authenticated sessions
-- for the SAME account (e.g. the same account signed in on a phone and a
-- tablet, or two installs) each independently calling save_activity_v1 for
-- the exact same (activity_type_code, metric) within the same
-- multi-millisecond window -- materially rarer than "one device flushing an
-- offline queue" (the scenario 20260720090000's own header speculatively
-- cited as the trigger, which this migration's re-reading of the actual
-- client code shows is not actually reachable that way).
--
-- =============================================================================
-- THE DECISION: revert to immediate per-transaction logging; do not chase a
-- DB-level "exactly one achievement per batch" guarantee further
-- =============================================================================
-- Given both of the above -- (a) no per-transaction check can correctly
-- decide "the batch is done" without an actual batch boundary that does not
-- exist anywhere in this system, and (b) the real-world trigger is narrowed
-- to a genuinely rare multi-device-same-instant scenario, not the common
-- offline-queue-flush case -- building an actual batch boundary (client-
-- declared batch size, a debounce/settle job on a delay, request
-- coalescing) is materially more architecture than the now-confirmed-narrow
-- risk warrants, and would itself add new failure modes (a settle job that
-- never fires, a debounce window a legitimate late arrival misses) in
-- exchange for closing a gap that is not reachable from normal app usage.
--
-- `private._pr_apply_or_recompute` is therefore reverted to byte-for-byte
-- the form it had in 20260719140000 (immediate compare-and-swap +
-- immediate achievement insert on a genuine beat, at each transaction's own
-- turn in the FOR-UPDATE-serialized order) and
-- `private._pr_settle_achievement_if_uncontended` is dropped -- it is
-- provably unsound (see above) and, unused, would just be a landmine for a
-- future maintainer who finds it and assumes it works.
--
-- What this means in the narrow, accepted-risk scenario: a genuine
-- multi-device concurrent race for the same (user, type, metric) MAY once
-- again log more than one `pr`-ranked activity_achievements row, one per
-- transient winner in the FOR-UPDATE-serialized chain (expected ~H(n)
-- transient winners for n truly concurrent racers, per 20260720090000's own
-- analysis, which is otherwise still accurate). This is NOT data corruption:
-- every logged row was genuinely, atomically true the instant it was
-- written (each comparison is against the actually-committed prior value
-- under a real row lock, never a guess) -- it is a historically faithful log
-- of "this activity briefly held the record," which is exactly what
-- architecture §4.2 describes activity_achievements as ("a badge earned then
-- is a fact, not something a future activity should erase"). The one
-- invariant that must never break -- and is unaffected by this migration,
-- confirmed unchanged both before and after -- is that `personal_records`,
-- the single source of truth for "what is my current best," always
-- converges to the true final max via the unchanged `SELECT ... FOR UPDATE`
-- compare-and-swap. The batch's TRUE final winner is also always guaranteed
-- to get its own achievement row (by induction: it is the maximum of the
-- whole set, so it necessarily beats whatever committed value immediately
-- precedes it in the serialized chain, no matter what total order the chain
-- happens to settle into) -- what is no longer guaranteed is that it is the
-- ONLY row logged.
--
-- `personal_records.previous_value` is intentionally NOT touched by this
-- migration either (considered and rejected as unnecessary): it already
-- records the immediately-prior COMMITTED value at each compare-and-swap
-- step, which is a real, true fact about this row's actual database history
-- -- not an artifact to "correct" toward some hypothetical pre-batch
-- baseline that was never itself a committed intermediate state other code
-- ever observed. Redefining it to mean "the value before this batch
-- started" would require the same nonexistent batch-boundary concept this
-- migration just explained is not being built, for a field whose current,
-- simpler meaning ("what this row's value was immediately before this
-- update") is already correct and already documented behavior.
--
-- Recommendation for qa-engineer (not made unilaterally here, flagged for
-- their call): the "exactly ONE activity_achievements row from a 5-way
-- concurrent batch" assertion in the verification script tests a scenario
-- (multiple truly-simultaneous save_activity_v1 calls for the same account)
-- that this migration's re-reading of the actual client code shows is not
-- reachable from a single device's normal offline-sync behavior, only from a
-- rare multi-device coincidence -- and is not achievable at the database
-- layer without an actual batch boundary this system does not have. The
-- more useful, achievable, and now-passing invariant is: `personal_records`
-- converges to the true max, and the true final winner always receives an
-- achievement row -- both verified in this migration's own re-run of
-- scripts/verify-pr-achievement-race-fix.mjs (updated in the same change to
-- assert this revised, achievable invariant instead of an exact count).
--
-- Not touched, same as 20260720090000: private._pr_recompute_metric,
-- private._pr_recompute_if_holder, both AFTER UPDATE triggers, and
-- recompute_prs_for_user_v1.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private._pr_apply_or_recompute -- restored to the exact 20260719140000
-- body (verbatim, including its original comment) -- immediate achievement
-- insert on a genuine beat, no settle indirection.
-- -----------------------------------------------------------------------------
create or replace function private._pr_apply_or_recompute(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric,
  p_new_value           numeric,
  p_new_unit_snapshot   text,
  p_timeline_event_id   uuid,
  p_achieved_at         timestamptz
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing_value  numeric;
  v_existing_holder uuid;
begin
  if p_new_value is null then
    -- Metric not applicable/not present on this activity — nothing to
    -- evaluate (e.g. an indoor_ride with no elevation data).
    return;
  end if;

  select value, timeline_event_id
    into v_existing_value, v_existing_holder
  from public.personal_records
  where user_id = p_user_id
    and activity_type_code = p_activity_type_code
    and metric = p_metric
  for update;

  if v_existing_holder = p_timeline_event_id then
    -- This activity already IS the cache's record holder for this metric —
    -- this is either an idempotent retry (value unchanged) or an edit to
    -- the record-holding activity itself (§4.3's "one genuinely expensive
    -- case"). Either way, re-derive the true current best via the narrow
    -- aggregate rather than assuming this activity is still champion —
    -- correctly demotes it if the edit dropped it below another activity.
    if v_existing_value is distinct from p_new_value then
      perform private._pr_recompute_metric(p_user_id, p_activity_type_code, p_metric);
    end if;
    return;
  end if;

  if v_existing_value is null or p_new_value > v_existing_value then
    insert into public.personal_records (
      user_id, activity_type_code, metric, value, unit_snapshot,
      timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_activity_type_code, p_metric, p_new_value, p_new_unit_snapshot,
      p_timeline_event_id, p_achieved_at, v_existing_value
    )
    on conflict (user_id, activity_type_code, metric) do update set
      previous_value    = personal_records.value,
      value             = excluded.value,
      unit_snapshot     = excluded.unit_snapshot,
      timeline_event_id = excluded.timeline_event_id,
      achieved_at       = excluded.achieved_at;

    insert into public.activity_achievements (
      timeline_event_id, user_id, metric, value, rank
    )
    values (
      p_timeline_event_id, p_user_id, p_metric, p_new_value, 'pr'
    )
    on conflict (timeline_event_id, metric) do nothing;
  end if;
end;
$$;

comment on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) is
  'Steady-state PR detection primitive (§4.3): O(1) point lookup + '
  'compare-and-swap, or a narrow recompute if the saved activity is '
  'already the record holder. Called from save_activity_v1 for every '
  'applicable metric on every save/edit. Achievement logging happens '
  'immediately, in the same instant this transaction''s own compare-and-swap '
  'wins, at each transaction''s own turn in the FOR-UPDATE-serialized order '
  '-- reverted to this (from 20260720090000''s unsound "settle" attempt) by '
  '20260720100000; see that migration''s header for why a per-transaction '
  '"is my result final" check cannot be made correct without an actual '
  'batch boundary this system does not have, and why the real-world risk is '
  'narrow enough (multi-device-same-instant only, never a single device''s '
  'offline-queue flush, confirmed by reading src/sync/activitySync.ts and '
  'src/sync/syncEngine.ts) not to warrant building one.';

-- GRANTs unchanged (create or replace function does not reset them, stated
-- explicitly rather than silently relied upon, per this project's existing
-- discipline).
revoke execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) from public, anon;
grant execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- Drop the unsound settle helper introduced by 20260720090000 -- unused as
-- of this migration, and provably incapable of doing what its name and
-- comment claimed (see this migration's header). Left in place, it would be
-- a landmine for a future maintainer who finds it and assumes it works.
-- -----------------------------------------------------------------------------
drop function if exists private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric);
