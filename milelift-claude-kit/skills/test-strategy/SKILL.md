---
name: test-strategy
description: Testing pyramid and coverage strategy for this app — what to test, at what layer, and what a good vs. superficial test looks like. Use when writing tests for new code, reviewing test coverage, or deciding what kind of test a change needs.
when_to_use: Invoke whenever new business logic ships, before marking a feature complete, or when auditing existing test coverage.
---

# Test Strategy

## The pyramid, applied to this app

**Unit tests (most of the suite, fastest, run on every save):**
- Pure business logic with no I/O: 1RM/strength estimation formulas, streak
  calculation across timezone/DST boundaries, unit conversion (kg↔lb,
  km↔mi), progressive-overload suggestion logic, subscription entitlement
  resolution (given these purchase events, is premium active).
- These are exactly the functions most likely to have a subtle off-by-one or
  edge-case bug, and cheapest to test exhaustively — test the boundaries
  (0, negative, exactly-at-threshold, leap year, DST transition day), not
  just one happy-path value.

**Integration tests (fewer, hit a real or realistic DB):**
- API endpoint behavior against a real test database: correct status codes,
  correct authorization enforcement (user A genuinely cannot fetch user B's
  data — assert this, don't just trust the code), idempotent write behavior
  on duplicate requests, correct pagination behavior at boundary counts.
- Migration tests: a migration applies cleanly to a representative dataset
  and is reversible.

**Contract tests:**
- Mobile client and backend agree on the API shape. If the contract is
  documented (OpenAPI), validate real responses against the schema in CI so
  drift is caught immediately, not discovered by a mobile crash in
  production.

**End-to-end tests (fewest, slowest, cover only critical user journeys):**
- Sign up → log a workout → see it persisted after app restart.
- Go offline → log a workout → come back online → confirm exactly one
  synced copy exists (this is the test that catches idempotency
  regressions).
- Complete a purchase flow → premium feature unlocks → simulate a refund
  webhook → premium feature is revoked.

## What makes a test good vs. superficial

- A good test asserts on **behavior/output**, not on internal implementation
  details that can change under a valid refactor.
- A good test's failure message tells you what's wrong without opening a
  debugger — assert specific expected values, not just "result is truthy."
- Time-dependent logic (streaks, "today," subscription expiry) uses an
  injectable/mockable clock in tests — never a real `sleep()` or a test that
  is quietly flaky depending on what day it's run.
- Don't chase 100% coverage on generated boilerplate, DTOs, or trivial
  getters — that's coverage theater. Do insist on coverage for anything with
  a conditional branch that affects money, data integrity, or access
  control.

## When a task is not actually done

- New business logic with no unit test covering at least the main branches
  and the obvious edge cases.
- A bug fix with no regression test — if it broke once with no test
  catching it, the fix isn't complete until there's a test that would have
  caught it.
- A test suite that was made to pass by weakening assertions rather than
  fixing the code — flag this explicitly if you find it, don't quietly
  leave it.

## Reporting

When reporting test status, state: what's covered, what's explicitly not
covered and why (acceptable gaps vs. real gaps), and current pass/fail
counts — not just "tests pass."
