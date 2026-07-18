---
name: security-review
description: Security audit checklist covering authentication, authorization, data protection, payments, and mobile-specific attack surface. Use for security reviews, before a release, or when implementing anything touching auth, payments, personal data, or file uploads.
when_to_use: Invoke before merging changes to auth, payments, user data endpoints, or file upload handling, and periodically as a full-codebase audit.
---

# Security Review

Adapted from OWASP API Security Top 10 and OWASP Mobile Top 10, scoped to
what actually applies to a fitness app: user accounts, health-adjacent
personal data, payments/subscriptions, and a mobile client talking to a
backend over the open internet.

## Authentication & session management

- Passwords hashed with a modern algorithm (bcrypt/argon2), never reversible
  encryption, never plaintext.
- Access tokens short-lived; refresh tokens rotated on use and revocable
  server-side (a stolen refresh token should be killable without forcing
  every user to reset a password).
- Biometric login (Face ID / fingerprint) on mobile unlocks a locally-stored
  credential — it does not itself replace server-side auth.
- Account lockout / rate limiting on login and password-reset endpoints to
  block credential stuffing.
- Session invalidation actually works: logout on one device shouldn't leave
  a valid token usable elsewhere if the user explicitly revoked it.

## Authorization (broken object-level auth is the #1 API risk)

- Every endpoint that takes a resource ID (workout ID, exercise log ID,
  user ID) verifies the requesting user owns or is permitted to access that
  specific resource — never rely on "the ID is hard to guess."
- Admin/coach-role endpoints check role server-side on every request, not
  just at login time or in the mobile UI.
- Social features (following, shared workouts, leaderboards) respect
  per-user privacy settings on the read path, not just hide-in-UI.

## Data protection

- TLS enforced everywhere; no cleartext HTTP fallback.
- Sensitive fields (auth tokens, refresh tokens) stored in iOS Keychain /
  Android Keystore on-device, never in plaintext shared preferences,
  AsyncStorage, or a local SQLite column without encryption.
- No PII or health data (weight, heart rate, GPS route, injury notes) in
  application logs, crash reports, or third-party analytics events unless
  explicitly necessary and explicitly disclosed to the user.
- Backups encrypted at rest; access to production data scoped and audited.

## Input handling

- All input validated server-side regardless of mobile-side validation —
  the mobile app is not a trusted boundary.
- Parameterized queries / ORM usage only — no string-concatenated SQL.
- File uploads (progress photos, form-check videos) validated for type and
  size server-side, scanned or sandboxed, served from signed URLs with
  short expiry rather than a public bucket with guessable paths.

## Payments & subscriptions

- Purchase/subscription status is never trusted from the client. App Store
  and Play Store receipts (or RevenueCat/Stripe webhook events) are verified
  server-side before unlocking premium features.
- Webhook endpoints verify the provider's signature before acting on the
  payload — an unauthenticated POST to a webhook URL must not be able to
  grant free premium access.
- Refund/chargeback events from the payment provider correctly revoke access
  server-side, not just log the event.

## Dependencies & infrastructure

- Dependency versions checked against known CVEs before a release (this is
  what the `devops-engineer` agent's release checklist enforces).
- Environment secrets injected via secret manager / CI secrets, never
  committed, never baked into a mobile app bundle (anything shipped in the
  app binary is extractable — this includes API keys with broad scope).
- CORS configured to actual allowed origins, not `*`, once there's a web
  surface.

## Report format

List findings as Critical / High / Medium / Low with the concrete exploit
scenario ("an authenticated user can view another user's private weight log
by incrementing the workout ID in the URL") rather than an abstract category
name. Include the fix, not just the finding.
