---
name: mobile-architecture-standards
description: Mobile client architecture conventions — offline-first sync, state management layering, secure storage, accessibility, and platform health integration. Framework-agnostic; add framework-specific idiom notes (React Native/Flutter/native) once the stack is chosen.
when_to_use: Invoke when building or reviewing any mobile screen, sync logic, local storage, or wearable/health-platform integration.
---

# Mobile Architecture Standards

This skill is written framework-agnostic on purpose. Once the mobile stack
is decided (React Native, Flutter, or native Swift/Kotlin), extend this file
with concrete framework idioms (state library, navigation library, storage
API) — the principles below hold regardless of which one you pick.

## Offline-first, not offline-tolerant

A fitness app is used mid-workout, often with poor gym/outdoor connectivity.
"Offline-tolerant" (shows an error when offline) is not good enough —
design offline-first:

- Local database is the source of truth for the UI. Screens read from local
  storage, not directly from a network call, so the UI works with zero
  connectivity.
- Writes go to local storage immediately (optimistic), then queue for
  background sync. The user logging a set should never wait on a network
  round-trip to see it recorded.
- A visible (not silent) sync-status indicator — the user should be able to
  tell "saved locally, syncing" from "confirmed synced" from "sync failed,
  will retry" for cases where it matters (e.g. before uninstalling the app).
- Define the conflict resolution rule explicitly and document it in code:
  what happens if the same workout was edited on two devices before either
  synced. Last-write-wins by server timestamp is a reasonable default;
  silently picking whichever request arrived first at the server is not a
  decision, it's an accident.

## State layering

Keep three layers distinct and don't collapse them into one global blob:

1. **Server cache state** — data fetched from or synced to the backend
   (workouts, exercise library, user profile). Has its own staleness/
   freshness semantics.
2. **Local domain state** — data that exists locally before/independent of
   sync (an in-progress workout being logged right now).
3. **UI state** — is this modal open, which tab is active, form field
   values before submit. Never persist ephemeral UI state as if it were
   domain data, and never let a UI component read/write server cache state
   directly without going through the sync layer — that's how a screen ends
   up silently out of sync with what actually got saved.

## Secure local storage

- Auth tokens and refresh tokens: platform secure storage (iOS Keychain,
  Android Keystore-backed encrypted storage) — never a plain key-value
  store, never plain SQLite columns, never bundled into a Redux/state
  persistence blob that gets dumped to disk unencrypted.
- Cached health data at rest on-device should be encrypted where the
  platform provides it as a reasonable-cost option, given its sensitivity.

## Platform health integration

- Request the minimum necessary HealthKit / Health Connect data types and
  read/write permissions for the current feature — see
  `health-data-compliance` for why over-broad requests fail review.
- Handle permission denial and later revocation as first-class states in the
  UI, not a crash — a user can revoke Health permission at any time from OS
  settings, independent of the app's lifecycle.
- Background sync from wearables respects OS background-execution limits;
  design for "sync opportunistically when the OS allows it," not "assume a
  persistent background connection."

## Accessibility (specifically relevant during a workout)

- Sufficient touch target size (effectively ~44x44pt minimum) — this app is
  frequently used one-handed, with sweaty or gloved hands, mid-set.
  Undersized tap targets aren't just an accessibility issue here, they're a
  core usability issue.
- Dynamic Type / font scaling support and screen-reader labels on
  interactive elements, not just decorative ones.
- Sufficient contrast for outdoor use in direct sunlight — don't rely on
  subtle color-only distinctions (e.g. "green means completed set") without
  a secondary non-color signal (icon/checkmark).

## Performance & battery

- GPS sampling rate for outdoor activity tracking is adjustable/reasonable,
  not maximum-frequency by default — continuous high-frequency GPS is a
  known fast battery drain and a common source of negative reviews.
- Startup time and app size are treated as product requirements, not
  afterthoughts — track them, don't let them regress silently as
  dependencies accumulate.

## Deep linking & notifications

- Streak/reminder push notifications deep-link to the specific relevant
  screen (today's workout, not just the app's home screen) — a generic
  landing on tap is a missed, cheap engagement opportunity and a common
  "why doesn't this just open the thing it told me about" complaint.
