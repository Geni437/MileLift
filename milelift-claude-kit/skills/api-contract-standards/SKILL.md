---
name: api-contract-standards
description: API design conventions for this codebase — resource naming, error format, idempotency, sync semantics, versioning. Use when designing or implementing any backend endpoint.
when_to_use: Invoke when adding, changing, or reviewing an API endpoint or its contract.
---

# API Contract Standards

## Resource design

- Nouns, not verbs: `/workouts`, `/workouts/{id}/sets`, not `/logWorkout`.
- Nesting reflects real ownership: sets belong to a workout, a workout
  belongs to a user — but cap nesting depth at two levels; go flatter with
  filter query params past that (`/sets?workout_id=`) rather than
  `/users/{id}/workouts/{id}/sets/{id}/notes`.
- Consistent pluralization and casing across every resource — pick one
  convention (this codebase should document its choice) and don't mix.

## Versioning

- Version in the URL path (`/v1/...`) so a breaking change is unambiguous
  and old mobile app versions in the field keep working against `/v1` while
  a new version ships as `/v2`. Mobile clients cannot be force-updated
  instantly — the API must tolerate at least one prior app version being in
  active use after a backend deploy.

## Error format

Every error response uses one consistent envelope, e.g.:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "reps must be a positive integer",
    "field": "sets[2].reps"
  }
}
```

`code` is a stable machine-readable string the mobile client can switch on;
`message` is for logs/debugging, not guaranteed to be shown verbatim to the
end user (localize on the client). Never return a raw stack trace or ORM
error message to the client.

## Idempotency (critical for this app)

Mobile clients on unreliable networks retry writes. Any endpoint that
creates a record based on a client action — logging a set, completing a
workout, recording a purchase — must accept a client-generated idempotency
key (e.g. a UUID generated on-device when the action first happens) and
return the same result on a duplicate submission instead of creating a
second record. This is the single most common source of "why do I have two
copies of the same workout" bugs in fitness apps with offline logging.

## Sync semantics

For any endpoint involved in offline-first sync:
- Support a `since`/cursor-based pull so a client can fetch only what
  changed, not the full history every time.
- Define and document the conflict resolution rule explicitly (e.g.
  last-write-wins by server timestamp, or field-level merge) — don't leave
  it implicit in whatever the code happens to do. See
  `mobile-architecture-standards` for the client side of this.
- Timestamps are stored and transmitted in UTC (ISO 8601). Any "did the user
  work out today" or streak logic operates on the user's local calendar day,
  computed from their device timezone at the time of the workout, not the
  server's timezone — get this wrong and streaks break at timezone
  boundaries and DST transitions.

## Pagination

Any list endpoint that can grow unbounded (workout history, activity feed,
exercise library) is paginated from day one — cursor-based for
feed/history (stable under concurrent inserts), offset is acceptable only
for small, rarely-changing lists.

## Webhooks (payments)

Payment provider webhooks (App Store Server Notifications, Play Developer
Notifications, Stripe/RevenueCat) are verified by signature before the
payload is trusted, processed idempotently (providers retry), and handled
asynchronously from the HTTP response (acknowledge receipt fast, process in
a queue) so a slow downstream step doesn't cause the provider to retry and
duplicate-process the same event.

## Documentation

The contract is written down (OpenAPI/Swagger or equivalent) and kept in
sync with the implementation — a mobile-builder agent implementing against
a stale contract is a direct cause of integration bugs.
