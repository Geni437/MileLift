---
name: deploy-checklist
description: Pre-release checklist for shipping backend deploys and mobile app store releases. Use before any production deploy or app store submission — this is a gate, not a suggestion.
when_to_use: Invoke before merging to a production deploy branch, before triggering a production deploy, or before submitting a mobile build to App Store/Play Store review.
argument-hint: "[backend|mobile|both]"
---

# Deploy Checklist

Run through the relevant section(s) before shipping. Report explicitly which
items pass, which fail, and which are not applicable — don't skip silently.
For anything destructive (running the actual deploy, forcing a rollback),
confirm with the person before executing; this skill's job is to verify
readiness, not to take the irreversible action unattended.

## Backend deploy

- [ ] Migrations tested against a copy of production-scale data volume, not
      just an empty local DB — a migration that's instant on 100 rows can
      lock a table for minutes on a real dataset.
- [ ] Migration has a working rollback path, or an explicit documented reason
      it's a one-way change (with a plan for what happens if the deploy needs
      to be reverted anyway).
- [ ] New/changed API endpoints are backward compatible with the currently
      live mobile app version(s) — a backend deploy cannot assume every
      client has updated. Confirm against the `api-contract-standards`
      versioning rule.
- [ ] Environment variables/secrets for the target environment are set and
      correct — verify, don't assume the last deploy's values still apply.
- [ ] Dependency versions checked for known vulnerabilities since the last
      release.
- [ ] Monitoring/alerting covers this change: error rate, latency, and any
      new failure mode this deploy introduces have an alert, not just a log
      line no one is watching.
- [ ] Rollback plan is written down before deploying, not improvised after
      something breaks.
- [ ] Feature-flag any behavior change that's risky or hard to predict at
      scale, so it can be disabled without a redeploy if it misbehaves.

## Mobile release (App Store / Play Store)

- [ ] Privacy nutrition label (Apple) / Data Safety form (Google) accurately
      reflects current data collection — checked against what the app
      actually does in this build, not the last time the form was filled
      out.
- [ ] HealthKit/Health Connect usage strings match the current feature set
      exactly (see `health-data-compliance`) — a stale purpose string is a
      common rejection reason.
- [ ] App works correctly against the currently-live backend API version —
      test against production or a production-mirroring staging environment,
      not just localhost.
- [ ] Staged rollout percentage set (don't default to 100% for a release with
      any meaningful risk) so a bad build affects a small cohort first.
- [ ] Crash-free rate and error monitoring dashboards are being watched
      immediately post-release, with a defined threshold for pulling the
      release.
- [ ] Release notes/changelog written for both the store listing and
      internal record.

## Payments-specific (when this release touches purchases/subscriptions)

- [ ] Sandbox/test-mode purchase flow verified end-to-end on the actual build
      being submitted, not an older build.
- [ ] Webhook handling for the payment provider verified against a signed
      test event, including the refund/cancellation path.

## Sign-off

State a clear go/no-go, not just a list of checked boxes — if anything above
is unresolved, say explicitly whether it blocks this release or is an
accepted, documented risk.
