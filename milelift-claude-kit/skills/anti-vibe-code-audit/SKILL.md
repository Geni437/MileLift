---
name: anti-vibe-code-audit
description: Detection checklist for identifying generic, unreviewed, or AI-slop code patterns in a diff or codebase. Use when reviewing pull requests, auditing existing code before a release, or whenever asked to check if code "looks vibe coded."
when_to_use: Invoke during code review, before merging a feature branch, or when auditing legacy/inherited code for hidden risk.
---

# Anti-Vibe-Code Audit

"Vibe coded" isn't a vague vibe — it's a specific, greppable set of patterns.
This skill is a detector, not an opinion. For each check, name the file and
line, don't just assert a general impression.

## Structural smells

- **Copy-paste residue**: a function/component that closely mirrors another
  one but still contains a variable name, comment, or string literal from the
  original context it was copied from (e.g. a `UserProfile` component with a
  leftover `ProductCard` class name).
- **Inconsistent conventions within one file**: camelCase and snake_case
  mixed in the same module, some functions with JSDoc/docstrings and
  identical sibling functions with none, inconsistent error response shapes
  between endpoints in the same router.
- **God functions**: a function doing validation + business logic + DB access
  + response formatting all in one block, with no separation. This is the
  single strongest signal of unreviewed first-draft code.
- **Dead code**: unused imports, unreachable branches, commented-out blocks
  left in instead of removed (version control is the history, not comments).
- **Unjustified abstraction**: a generic `BaseHandler`/`AbstractService` with
  exactly one subclass and no second use case in sight — abstraction added
  because it "looked professional," not because it solves a real problem.

## Correctness smells

- **Empty or overly broad error handling**: `catch (e) {}`, `except: pass`,
  or `catch (e) { console.log(e) }` with no actual recovery or propagation.
- **Silent type coercion**: comparing/concatenating values across types
  without an explicit cast, relying on the language to paper over it.
- **No null/undefined checks** on data that can legitimately be absent
  (optional profile fields, a workout with no notes, a user with no
  subscription).
- **Off-by-one / boundary bugs in pagination or streak calculations** —
  fitness apps are full of "count consecutive days" logic; check that
  timezone boundaries and daylight saving transitions are actually handled,
  not assumed away.
- **N+1 queries**: a loop that issues one DB call per iteration where a
  single joined/batched query would do — very common in "list workouts with
  their exercises" style endpoints.

## Security-adjacent smells (flag, then hand off to `security-review`)

- Secrets, tokens, or API keys as literals in source, config committed to the
  repo, or logged in plaintext.
- User-supplied IDs used directly in a DB lookup with no ownership check
  (classic IDOR: user A fetching user B's workout by guessing the ID).
- Client-reported values trusted for anything that has financial or access
  implications (e.g., trusting a mobile-reported "subscription active" flag
  instead of verifying server-side against the payment provider).

## Test smells

- New business logic (streak calculation, 1RM estimation, unit conversion,
  sync conflict resolution) shipped with zero corresponding tests.
- Tests that assert on implementation details instead of behavior (a test
  that breaks on any refactor even when behavior is unchanged is a maintenance
  liability, not a safety net).
- A test suite that passes only because assertions were weakened to match
  whatever the code currently does, rather than what it should do.

## How to report findings

For every issue found, give: file path + line number, a one-line description
of the pattern, why it matters concretely (not "this is bad practice" but
"this will silently drop a user's logged set if the request retries"), and a
specific fix — not "improve error handling," but the actual code change.

Group findings as:
- **Blocking** — will cause data loss, a security gap, or a crash in a
  realistic path.
- **Should fix** — will cause confusion, maintenance cost, or subtle bugs
  under less common conditions.
- **Nit** — style/consistency only, doesn't affect correctness.

Don't pad the report with praise for unremarkable code that simply has no
issues — silence on a file is the signal that it's fine.
