---
name: health-data-compliance
description: Compliance checklist for handling health-adjacent personal data (weight, heart rate, sleep, workout history, GPS routes, progress photos) — consent, minimization, deletion, and platform health-data policies. Use when designing or reviewing any feature that collects, stores, syncs, or displays personal health or biometric data.
when_to_use: Invoke during architecture design for any feature touching HealthKit/Health Connect, biometrics, location, or user-uploaded photos, and during pre-release review.
---

# Health Data Compliance

This is engineering-facing guidance to flag risk early, not a legal opinion —
have actual counsel review data handling for the specific markets you launch
in (rules differ meaningfully between the EU/GDPR, US state laws, and
wherever else you have users; confirm current requirements rather than
assuming, since this area moves).

## Why this gets its own skill

Weight, heart rate, sleep, and location data are treated as sensitive/special
category data under most modern privacy frameworks — a higher bar than
ordinary account data (name, email). Apple and Google also gate HealthKit
and Health Connect access behind their own review policies independent of
law. Getting this wrong surfaces late — at App Store review or at a user
complaint — which is expensive precisely because it's late.

## Data minimization

- Request only the HealthKit / Health Connect data types the current feature
  actually uses. "We might need it later" is not a justification for a scope
  request now — it fails review and erodes user trust.
- Don't persist raw wearable data you don't display or compute from. If a
  derived metric (e.g. weekly average heart rate) is all the product needs,
  consider whether storing only the derived value, not the raw stream, is
  sufficient.

## Consent

- Ask for each data category (health data, location, camera/photos) at the
  point of use, with a specific purpose string, not a single bundled
  permission prompt at signup for everything.
- Health data processing generally needs explicit, specific consent — not
  bundled into general "I agree to terms" consent, and not inferred from
  continued app use.
- Make withdrawal of consent actually functional: if a user revokes
  HealthKit access, the app must degrade gracefully, not crash or silently
  keep using stale cached data as if it were still authorized.

## User rights the system must actually support

- **Export**: a user can get their own workout history and health data in a
  usable format on request — this needs to be a real, tested code path, not
  a support-ticket manual process that doesn't scale.
- **Deletion**: account deletion must cascade to workout logs, biometric
  data, uploaded photos, and backups within a stated timeframe — not leave
  orphaned rows because deletion was only wired up for the `users` table.
  Decide explicitly whether deletion is hard-delete or anonymization, and
  apply that decision consistently (see `db-schema-standards`).
- **Correction**: a user can fix an incorrect logged weight/measurement
  without filing a support request.

## Platform-specific requirements

- **Apple HealthKit**: usage strings (`NSHealthShareUsageDescription` /
  `NSHealthUpdateUsageDescription`) must accurately describe the specific
  use. Apple's guidelines prohibit using HealthKit data for advertising or
  selling it to data brokers — this is a review-blocking issue, not a
  suggestion.
- **Google Health Connect**: similar minimum-necessary-scope expectation,
  plus the Play Console "Data Safety" form must accurately reflect what's
  actually collected — this form is checked against real app behavior during
  review and updates lag being a common source of rejection.
- Both platforms expect a clearly linked, specific privacy policy (not a
  generic boilerplate one) describing health data handling before requesting
  these permissions.

## Third-party data sharing

- Analytics/crash-reporting SDKs must not receive raw health values in event
  payloads — audit what's actually sent, not just what you intended to send
  (a stray `user.toJSON()` in an analytics call is a common accidental leak).
- Any data shared with a coach, trainer, or social-feed audience must respect
  the user's explicit sharing choice per data type, not an all-or-nothing
  "public profile" toggle if the product implies more granular control.

## What to flag to the human, not decide silently

- Which jurisdiction(s) the app targets at launch, since that determines
  which specific legal framework applies.
- Data retention period after account deletion (some backup/legal-hold
  retention may be required even after user-facing deletion).
- Whether the app is a covered entity/business associate under any
  health-specific regulation in a given market — this depends on exact
  product framing (fitness tracking vs. clinical guidance) and should be a
  deliberate legal call, not an engineering assumption.
