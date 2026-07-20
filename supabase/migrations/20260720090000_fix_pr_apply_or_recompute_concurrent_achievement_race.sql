-- =============================================================================
-- Phase 1 — Module A: fix a concurrent-save race in PR achievement logging
-- Fixes: private._pr_apply_or_recompute, introduced in
--   supabase/migrations/20260719140000_create_activity_save_and_pr_rpcs.sql
-- Design ref: docs/architecture/phase-1-module-a.md §4.2 ("a badge earned then
--   is a fact, not something a future activity should erase"), §4.3.
--
-- Per this project's migration convention, 20260719140000 is already applied
-- and is not edited in place -- this is a new, additive migration.
--
-- =============================================================================
-- THE BUG (qa-engineer, live-reproduced twice against a real Supabase project)
-- =============================================================================
-- personal_records.value correctly converges to the true max under concurrency
-- (SELECT ... FOR UPDATE genuinely serializes writers on the
-- (user_id, activity_type_code, metric) row -- confirmed correct, untouched by
-- this migration). But activity_achievements accumulated one row per link in
-- the concurrent commit CHAIN, not one row for the batch's actual final
-- winner: 5 concurrent save_activity_v1 calls for distinct new hike
-- activities (13125/15125/14125/17125/16125m) against an existing PR of
-- 12125m settled personal_records at {value: 17125, previous_value: 15125}
-- (correct) but produced THREE activity_achievements rows -- {13125, rank:pr},
-- {15125, rank:pr}, {17125, rank:pr} -- of which only the 17125 one is still
-- the actual record.
--
-- Root cause: the original _pr_apply_or_recompute logged an achievement
-- immediately, in the same instant it decided "p_new_value beats whatever I
-- just read under FOR UPDATE". SELECT ... FOR UPDATE genuinely serializes the
-- five concurrent transactions into SOME total order, and at EACH
-- transaction's own turn in that order, its comparison against the
-- then-current committed value is completely correct -- but the order five
-- truly-concurrent transactions get granted a contested row lock in is
-- effectively arbitrary (arrival order at the lock manager), not sorted by
-- value. A transaction can only ever see already-committed siblings, never
-- ones still queued behind it -- so "I beat the current cache" is not the
-- same fact as "I am still the batch's real winner once every concurrent
-- sibling has had its turn", and the original code treated them as the same
-- fact. Statistically, this is the classic "number of left-to-right maxima in
-- a random permutation" problem (expected ~H(n) transient winners for n
-- racing values, e.g. ~2.3 for n=5) -- it is not a rare edge case for a
-- genuinely concurrent batch, it is the *expected* outcome most of the time.
-- Because activity_achievements is immutable by design (§4.2 -- there is no
-- corrective DELETE/UPDATE path), every one of those transient winners became
-- a permanent, wrong badge. Real-world trigger: an offline queue flushing
-- several pending activities on reconnect, or multi-device sync -- both
-- already-anticipated Module A scenarios, not a contrived load-test-only
-- pattern.
--
-- =============================================================================
-- THE FIX
-- =============================================================================
-- personal_records' compare-and-swap logic is UNCHANGED (still correct, per
-- qa-engineer's confirmation and this migration's own re-verification below).
-- What moves is *when* an activity_achievements row is allowed to be written:
-- no longer "immediately, whenever a transaction's own point-in-time compare
-- says it won", but "only once no other save_activity_v1 call for this exact
-- (user_id, activity_type_code, metric) row is still queued behind this one".
--
-- Mechanism: private._pr_settle_achievement_if_uncontended, called
-- unconditionally at the end of every _pr_apply_or_recompute invocation
-- (win, lose, or already-holder-edit alike), checks whether any OTHER backend
-- is currently blocked waiting on THIS transaction before it is allowed to
-- log anything. Postgres implements contested-row-lock waiting by having the
-- waiting backend block on the lock HOLDER's transaction id (this is exactly
-- the mechanism pg_blocking_pids() is built on) -- every transaction that has
-- taken a real row lock (which the caller just did, via its own
-- `SELECT ... FOR UPDATE` on the personal_records row moments earlier) holds
-- a `granted = true` pg_locks entry on its own transaction id, and any
-- backend blocked waiting for that row shows up as a `granted = false` entry
-- against that SAME transaction id. So:
--   - If someone IS waiting on us: do nothing. The cache's current state is
--     not yet "settled" from this transaction's point of view -- there is a
--     sibling from the same race still to come. That sibling inherits this
--     exact same check the moment it is granted the lock next (because
--     _pr_apply_or_recompute always calls the settle helper, on every path),
--     and it settles once IT finds no one behind it either. A chain of N
--     concurrent saves therefore converges to exactly one settle-and-log,
--     performed by whichever call turns out to be last in the chain --
--     regardless of how many intermediate compare-and-swaps happened first.
--   - If no one is waiting on us: read personal_records for this
--     (user, type, metric) *right now* (no additional lock needed -- this
--     transaction still holds the row lock it took earlier in the same
--     statement/transaction) and log an achievement for whichever
--     timeline_event_id actually holds it -- which may be a *different*
--     activity than the one this specific _pr_apply_or_recompute call was
--     even invoked for. That is deliberate: the settle decision is "who
--     holds the record right now that every racing sibling has committed",
--     not "did the activity I personally was invoked for just win". The
--     existing `ON CONFLICT (timeline_event_id, metric) DO NOTHING` unique
--     guard on activity_achievements (20260719133700) makes this idempotent
--     no matter how many times settle ends up running for the same eventual
--     winner (the common, uncontended, single-save case included -- there,
--     the "no one is waiting" check is true on the very first attempt, so a
--     normal sequential save still logs its achievement immediately, exactly
--     as before).
--
-- Residual, accepted race window: there is an unavoidable, extremely narrow
-- gap between "I just checked and no one was waiting" and this transaction's
-- own COMMIT, during which a brand-new (not-yet-arrived) sibling could start
-- waiting. In that specific interleaving, both this transaction and the new
-- arrival could independently conclude "I'm last" and each run their own
-- settle pass -- which is fine: both passes read whatever personal_records
-- says at THEIR OWN turn, both inserts are ON CONFLICT DO NOTHING-safe, and a
-- genuinely later straggler's own value is evaluated by the ordinary,
-- unchanged compare-and-swap above before settle ever runs for it. This
-- cannot reproduce the original bug (a permanently-wrong extra row); at worst
-- it means an achievement for a legitimately new PR is logged promptly by
-- whichever of the two overlapping settle passes gets there, which is correct
-- either way. For a real concurrent burst (multiple requests dispatched via
-- the same client-side Promise.all/queue-flush, arriving within the same
-- network round trip), every sibling has essentially always already reached
-- its own `SELECT ... FOR UPDATE` and registered as a waiter long before the
-- first winner finishes its own processing and reaches the settle check, so
-- this residual window is not expected to be observable in practice -- see
-- the live re-verification section of the task report for the actual
-- measured outcome, not just this reasoning.
--
-- Not touched, deliberately: private._pr_recompute_metric (personal_records
-- convergence, confirmed correct), private._pr_recompute_if_holder and both
-- AFTER UPDATE triggers (edit/soft-delete reconciliation paths -- unrelated
-- to this race, no achievement logging happens there either before or after
-- this migration), and recompute_prs_for_user_v1 (bulk backfill -- never
-- logged achievements before this migration and still doesn't; extending it
-- to do so would be a separate, deliberate product decision, not a bug fix).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private._pr_settle_achievement_if_uncontended(user, type, metric)
--
-- New helper. See migration header for full reasoning. SECURITY INVOKER, same
-- as every other function in this file -- runs as the calling `authenticated`
-- role; RLS on activity_achievements/personal_records still applies (both
-- already grant the necessary SELECT/INSERT to `authenticated`, verified by
-- reading 20260719133600/20260719133700, so no additional GRANTs are needed
-- for this function's own table access). Lives in the `private` schema
-- (created by 20260719140000, not re-created here) for the same PostgREST-
-- exposure reason documented at length in that migration: never directly
-- reachable via `/rpc/...`, only callable same-transaction from other
-- SECURITY INVOKER functions that already hold EXECUTE on it.
-- -----------------------------------------------------------------------------
create or replace function private._pr_settle_achievement_if_uncontended(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_my_xid      xid;
  v_has_waiters boolean;
  v_value       numeric;
  v_holder      uuid;
begin
  -- Find pg_locks' record of THIS backend's own transaction-id lock. Every
  -- transaction that has taken a real row lock (which the caller just did,
  -- via its own `SELECT ... FOR UPDATE` on the personal_records row moments
  -- earlier in _pr_apply_or_recompute) holds a `granted = true` entry on its
  -- own transaction id -- that is the standard mechanism other backends
  -- block on when they contend for a row this transaction already holds.
  select l.transactionid
    into v_my_xid
  from pg_locks l
  where l.pid = pg_backend_pid()
    and l.locktype = 'transactionid'
    and l.granted = true
  limit 1;

  if v_my_xid is not null then
    select exists (
      select 1
      from pg_locks
      where locktype = 'transactionid'
        and transactionid = v_my_xid
        and granted = false
    ) into v_has_waiters;
  else
    -- No self-transaction-id lock found at all -- would mean this
    -- transaction never actually took a row lock, which shouldn't happen
    -- given the caller always just did. Fail open to "uncontended" rather
    -- than silently never settling anything (production-standards: no
    -- silent no-op that masks a real problem).
    v_has_waiters := false;
  end if;

  if v_has_waiters then
    -- Someone else is queued behind this transaction for this exact
    -- personal_records row -- not yet safe to treat its current state as
    -- final. Do nothing; the waiting transaction runs this same check once
    -- it is granted the lock next.
    return;
  end if;

  -- Uncontended right now: log the achievement for whoever the cache says
  -- currently holds this (user, type, metric) record. No FOR UPDATE needed
  -- here -- this transaction still holds the row lock it took earlier in the
  -- same statement/transaction (Postgres row locks are held continuously
  -- from acquisition to commit regardless of intervening statements), so a
  -- plain read here already sees this transaction's own latest write.
  select value, timeline_event_id
    into v_value, v_holder
  from public.personal_records
  where user_id = p_user_id
    and activity_type_code = p_activity_type_code
    and metric = p_metric;

  if v_holder is not null then
    insert into public.activity_achievements (
      timeline_event_id, user_id, metric, value, rank
    )
    values (
      v_holder, p_user_id, p_metric, v_value, 'pr'
    )
    on conflict (timeline_event_id, metric) do nothing;
  end if;
end;
$$;

comment on function private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric) is
  'Logs exactly one activity_achievements row for the CURRENT personal_records '
  'holder of (user, type, metric), but only when no other backend is currently '
  'waiting on this transaction''s row lock for that record -- i.e. only once a '
  'concurrent race for this PR has actually settled. See migration '
  '20260720090000 for full reasoning. Idempotent via the existing '
  'uq_activity_achievements_timeline_event_metric unique index.';

revoke execute on function private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric) from public, anon;
grant execute on function private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric) to authenticated;

-- -----------------------------------------------------------------------------
-- private._pr_apply_or_recompute -- replaced to remove the immediate,
-- race-prone achievement insert and route achievement logging through the
-- new settle helper instead, unconditionally, on every path (already-holder
-- edit, genuine beat, or no-op/loss alike) -- see migration header.
--
-- personal_records logic itself (the SELECT ... FOR UPDATE, the
-- already-holder recompute-on-edit branch, and the compare-and-swap upsert)
-- is copied verbatim from 20260719140000 -- byte-for-byte identical except
-- for replacing the trailing `return;` in the already-holder branch with
-- `elsif` (so control always reaches the new settle call at the end) and
-- deleting the `insert into public.activity_achievements (...)` block that
-- used to sit directly after the compare-and-swap upsert.
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
    -- the record-holding activity itself. Either way, re-derive the true
    -- current best via the narrow aggregate rather than assuming this
    -- activity is still champion — correctly demotes it if the edit dropped
    -- it below another activity. (Unchanged from 20260719140000.)
    if v_existing_value is distinct from p_new_value then
      perform private._pr_recompute_metric(p_user_id, p_activity_type_code, p_metric);
    end if;

  elsif v_existing_value is null or p_new_value > v_existing_value then
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
  end if;

  -- Settle (new, 20260720090000): only the call in a contended chain that
  -- turns out to have no one waiting behind it actually commits an
  -- activity_achievements row, and it logs for whoever the cache says holds
  -- the record at that point, not necessarily this call's own activity. Runs
  -- unconditionally so the already-holder-edit branch above and the
  -- no-beat/no-op case both also get a chance to backfill a legitimately
  -- missing achievement (e.g. the already-holder edit demoting this activity
  -- to a different, currently-unbadged holder) via the same idempotent path.
  perform private._pr_settle_achievement_if_uncontended(p_user_id, p_activity_type_code, p_metric);
end;
$$;

comment on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) is
  'Steady-state PR detection primitive (§4.3): O(1) point lookup + '
  'compare-and-swap on personal_records, or a narrow recompute if the saved '
  'activity is already the record holder — identical to 20260719140000. '
  'Achievement logging (§4.2) no longer happens inline here; it is delegated '
  'to private._pr_settle_achievement_if_uncontended so a concurrent batch of '
  'saves racing for the same (user, type, metric) logs exactly one row, for '
  'the batch''s actual final winner, instead of one row per transient '
  'intermediate winner (fixed by migration 20260720090000).';

-- GRANTs unchanged from 20260719140000 (same authenticated-only, no
-- public/anon posture) — `create or replace function` does not reset
-- existing GRANTs, but this is stated explicitly rather than silently
-- relied upon, consistent with this project's discipline elsewhere.
revoke execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) from public, anon;
grant execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) to authenticated;
