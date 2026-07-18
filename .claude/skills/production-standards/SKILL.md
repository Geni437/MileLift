---
name: production-standards
description: Non-negotiable baseline for any code written or modified in this codebase. Use for every implementation task — new features, bug fixes, refactors. Defines what "production-ready" means concretely so output doesn't read as a demo or first draft.
when_to_use: Always active for backend, mobile, and database implementation work. Re-check this list before reporting any task as done.
---

# Production Standards

This is the bar every change must clear before it's "done." It exists because
"looks right" and "is production-ready" are different things, and the gap is
almost always in the parts a first draft skips.

## Before writing code

- Confirm you know the actual data shape (real field names, types, nullability)
  by reading the schema/model, not guessing from the feature name.
- If the task implies a design decision that hasn't been made (sync strategy,
  auth flow, retry policy), stop and flag it rather than picking silently.
  Silent assumptions are how "vibe coded" architecture happens — a dozen small
  unstated choices that don't cohere because no one decided them on purpose.

## Every function/endpoint/screen must handle

1. **The unhappy path first-class, not as an afterthought.** Network failure,
   empty result set, malformed input, expired session, concurrent edit,
   partial write. If you can't name what happens when the DB call times out,
   the code isn't done.
2. **Input validation at the boundary.** Never trust client input, including
   your own mobile app's input — assume a modified client or replayed request.
   Validate type, range, and business invariants (e.g., a logged set can't
   have negative reps, a workout date can't be in the future by more than the
   client's clock skew tolerance).
3. **Explicit error types, not generic exceptions.** A caller should be able
   to distinguish "not found" from "not authorized" from "validation failed"
   from "downstream service down" without string-matching an error message.
4. **Idempotency where retries are possible.** Mobile clients retry on flaky
   networks. Any write endpoint a mobile client calls (workout sync, purchase
   confirmation) must be safe to call twice with the same payload.
5. **Logging that would actually help you at 2am**, without logging secrets,
   tokens, or health data (weight, heart rate, GPS routes) in plaintext.

## Forbidden, no exceptions

- `TODO`, `FIXME`, `// implement later`, or stub functions that return mock
  data as if it were real, in anything reported as complete.
- Swallowing exceptions with an empty `catch` block or a bare `except: pass`.
- Hardcoded secrets, API keys, or environment-specific URLs in source.
- Magic numbers/strings with no named constant where the value has meaning
  (a `30` that means "session timeout minutes" needs a name).
- Copy-pasting a similar function/component and only partially adapting it
  (leftover references to the thing you copied from — a dead giveaway of
  generated-not-reviewed code).
- Disabling a linter/type-checker rule inline to make an error go away instead
  of fixing the underlying issue. If a rule is genuinely wrong for this case,
  say so explicitly and justify it in a comment, don't just suppress silently.
- Returning `200 OK` (or the mobile-side equivalent of "looks fine") on a
  partial failure. Fail loudly and specifically.

## Definition of done

A task is done when:
- The happy path works.
- The unhappy paths above are handled, not just the happy path.
- There's a test covering the new business logic (see the `test-strategy`
  skill) — "I tested it manually once" is not a test.
- Naming is specific enough that someone reading only the function/variable
  names (no comments) can mostly follow the logic.
- You've stated, in your summary, any assumption you made and any follow-up
  work that's genuinely out of scope for this task — not buried, not omitted.

## Why this matters for this specific app

Fitness apps accumulate two kinds of debt fast if corners are cut: silent
data corruption in workout history (a user's training log is the entire
product value — get it wrong and they lose trust and dropping churn is
already a known SaaS problem for personal fitness), and silent security gaps
around health-adjacent data (weight, heart rate, location) that turn into
compliance and App Store review problems late, when they're expensive to fix.
Cutting corners here doesn't save time — it moves the time to a worse moment.
