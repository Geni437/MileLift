# MileLift — Master Build Prompt

This is the operating instruction for building MileLift end to end. Paste
this whole document into Claude Code as your first message in a fresh
session, in a project that has this kit installed (`.claude/agents/`,
`.claude/skills/`, and `docs/spec/MileLift-Product-Spec.md` all present).

## Ground truth

`docs/spec/MileLift-Product-Spec.md` is the canonical product spec. Every
feature ID referenced below (CORE-XX, UNQ-XX, AI-XX) is defined there in
full — this document sequences the build and defines what "done" means per
phase; it does not restate feature descriptions. Read the spec in full
before starting Phase 0, and re-read the relevant section before starting
each subsequent phase.

## The rule that overrides everything else in this document

**One phase at a time. A phase is not complete until its gate criteria pass
and the person has explicitly approved moving on.** Do not start
implementation work on the next phase — even "just to get a head start" —
before that approval. If you find yourself blocked because a decision or a
prior phase's output is missing, stop and ask rather than assuming an
answer and proceeding. Ambiguity about *this specific rule* is never a
reason to keep moving; it's the reason to stop.

If a gate fails: stay in the current phase, fix the specific failure, and
re-run the gate. Don't patch the failure forward into the next phase's
scope, and don't weaken the gate criteria to make a failing phase pass.

## How the agents actually work together

You (the main session) are the orchestrator. For each phase below:

1. Delegate to the agent(s) named for that phase, in the order listed.
   Where a phase lists agents "in parallel," you may delegate to more than
   one at once, but pass each one the specific, scoped task — not the whole
   phase description undifferentiated.
2. Carry forward what one agent produces into the next agent's task. An
   `architect` design doc is the actual input to the builder agents that
   follow it, not background color — read it and hand its concrete
   decisions to them explicitly.
3. Read-only reviewer agents (`code-reviewer`, `security-auditor`,
   `design-reviewer`) run after implementation, against the real diff —
   never skip straight to "looks good" without actually invoking them.
4. After every agent in the phase has run and every reviewer has reported,
   summarize the phase's outcome against its gate criteria for the person,
   and wait for their explicit approval before touching anything in the
   next phase.

## Standards that apply to every phase, without exception

Every agent in this kit already preloads `production-standards`. Two
project-wide rules on top of that, worth restating because they cut across
every phase:

- **RLS is written in the same migration as the table it governs.** No
  table ships without it, per `supabase-standards`.
- **Every AI-native feature ships with the confidence-escalation pattern**
  from `ai-orchestration-standards` — low-confidence output is a suggestion
  requiring confirmation, never silently authoritative.

## Do these in parallel with Phase 0, not after it

A few items have real external lead time and gain nothing from waiting for
their phase to start:

- **Trademark and domain availability check for "MileLift"** — flagged as
  outstanding in the spec's own Naming section. Not an engineering task;
  flag it to the person now if it hasn't been started.
- **Wearable developer program applications** (Garmin Connect Developer
  Program, Apple Developer / HealthKit entitlement, Wear OS / Health
  Connect) — approval can take real time and gates CORE-03. Start the
  applications now even though the integration code comes in Phase 1.
- **USDA FoodData Central and Open Food Facts**: confirm current
  attribution/license terms per `nutrition-data-standards` before Phase 3
  builds against them, since terms are worth verifying fresh rather than
  assumed.

---

## Phase 0 — Foundation

**Scope:** CORE-18 (single unified profile/auth). The canonical timeline
data model every module writes into. The original design-token system and
app shell. Supabase project setup across environments. CI/CD skeleton.

**Agents:** `architect` (canonical timeline + data model, this is the
single most load-bearing decision in the whole build) → `db-engineer`
(auth/profile schema + RLS) → `ui-ux-designer` (token system — see the
color-palette note in its own instructions regarding the spec's
competitor-derived rationale) → `mobile-builder` (app shell, auth screens,
navigation) → `devops-engineer` (CI/CD, environments, secrets).

**Gate:**
- [ ] `architect`'s canonical timeline design is written down and the
      person has confirmed it before any module schema is built against it.
- [ ] Sign-up → login → profile exists as one real row in `profiles`,
      tested end to end, not just "the code looks right."
- [ ] RLS confirmed fail-closed: a second test account cannot read the
      first account's profile data.
- [ ] `security-auditor` review of the auth/profile schema and RLS
      baseline.
- [ ] `design-reviewer` confirms the token system is original, not a
      literal reproduction of the spec's competitor-color reference.
- [ ] CI pipeline runs lint/type-check/test on a real commit.
- [ ] Person's explicit approval.

---

## Phase 1 — Module A: Activity & Movement Tracking (core)

**Scope:** CORE-01 through CORE-05 — GPS recording (single-sensor baseline;
fusion comes in Phase 8), route mapping/history, wearable sync, PRs/
achievements, activity feed/kudos.

**Agents:** `architect` (module data model, fitting into the canonical
timeline) → `backend-builder` + `db-engineer` (in parallel) →
`mobile-builder` → `ui-ux-designer` (recording screen, activity feed,
per `ui-ux-design-standards`' screen-specific guidance) → `qa-engineer` →
`code-reviewer`, `design-reviewer`, `security-auditor`.

**Gate:**
- [ ] A real GPS-recorded activity, recorded end to end on a device, is
      persisted and viewable in history.
- [ ] Wearable sync tested against at least one real device/platform, not
      just a mocked payload.
- [ ] PR/achievement detection tested against a realistic history, not just
      a single clean example.
- [ ] Activity feed respects privacy/ownership — a second account cannot
      read activities that aren't shared with it.
- [ ] All four reviewer agents report, findings addressed or explicitly
      accepted as known follow-up.
- [ ] Person's explicit approval.

---

## Phase 2 — Module C: Strength Training & Workout Logging (core)

**Scope:** CORE-12 through CORE-17 — set/rep/weight logging with rest
timer, exercise library with video, custom workout/program builder,
progress analytics, progress photos/measurements, offline logging with
background sync.

**Agents:** `architect` (module data model + the exercise-library
snapshot-vs-reference decision from `db-schema-standards`) →
`db-engineer` + `backend-builder` (parallel) → `mobile-builder` (offline-
first per `mobile-architecture-standards` — this is the hardest item in
this phase) → `ui-ux-designer` → `qa-engineer` → reviewer trio.

**Gate:**
- [ ] **Offline → online sync test is mandatory, not optional**: log a
      full workout in airplane mode, return online, confirm exactly one
      synced copy exists (idempotency), per the spec's own "non-negotiable"
      language on CORE-17.
- [ ] Editing an exercise library entry after a set was logged against it
      does not retroactively change the historical log (snapshot rule).
- [ ] Progress photos/measurements handled per `health-data-compliance`.
- [ ] Exercise library content-sourcing decision (license vs. produce, for
      the 1,400+ movement target) is either resolved or explicitly flagged
      as an open item with a placeholder strategy the person has approved.
- [ ] Reviewer trio + `qa-engineer` sign-off.
- [ ] Person's explicit approval.

---

## Phase 3 — Module B: Nutrition & Food Logging (core)

**Scope:** CORE-06 through CORE-11 — food logging against the open-data
sources, barcode scanning, macro tracking, water intake, recipe/meal
saving, manual exercise/calorie-burn logging that reconciles with Module A.

**Agents:** `architect` (nutrition data model + the Module A reconciliation
design — this is the first real use of the canonical timeline's
cross-module read) → `db-engineer` + `backend-builder` (data ingestion
per `nutrition-data-standards`) → `mobile-builder` → `ui-ux-designer` →
`qa-engineer` → reviewer trio.

**Gate:**
- [ ] USDA FDC + Open Food Facts ingestion pipeline runs and produces a
      searchable local dataset; merge/dedup and unit-normalization logic
      tested against at least one known source-disagreement case.
- [ ] Attribution requirements for both data sources are actually visible
      in the shipped app, not just noted internally.
- [ ] CORE-11 reconciliation verified concretely: log a workout in Module
      A, confirm the calorie-burn figure appears correctly in Module B
      without double-counting.
- [ ] Barcode scanning works offline against the cached dataset.
- [ ] Reviewer trio + `qa-engineer` sign-off.
- [ ] Person's explicit approval.

---

## Phase 4 — Module D: Community & Platform (core, non-agentic billing)

**Scope:** CORE-19 (community feed, challenges, friend following), CORE-20
(transparent free tier + subscription). This is the actual payment
integration and entitlement resolution — **not** AI-18's agentic layer,
which is deliberately deferred to Phase 12.

**Agents:** `architect` (subscription/entitlement model) → `backend-builder`
(payment provider webhook handling, entitlement resolution — server-side
verified per `security-review`, never client-trusted) → `mobile-builder`
(purchase flow, community screens) → `ui-ux-designer` → `qa-engineer` →
reviewer trio.

**Gate:**
- [ ] Sandbox purchase → entitlement → feature unlock tested end to end.
- [ ] Refund/cancellation webhook correctly revokes access, tested against
      a real signed test event, not assumed from reading the code.
- [ ] Community feed RLS tested: a private account's data isn't visible to
      a user who shouldn't see it.
- [ ] Free tier is genuinely usable standalone, per the spec's own
      "transparent free tier" positioning — verify this isn't quietly a
      crippled trial.
- [ ] Person's explicit approval.

---

## Phase 5 — Differentiators from Strava (UNQ-01 through UNQ-05)

**Scope:** Segments & leaderboards, live segment updates, group challenges/
badges, route discovery via heatmaps, privacy zones.

**Agents:** `architect` → `backend-builder` + `db-engineer` →
`mobile-builder` → `ui-ux-designer` → `qa-engineer` → reviewer trio.

**Gate:**
- [ ] Leaderboard correctness verified against a realistic multi-user
      dataset.
- [ ] **Privacy zones actually hide the real start/end point** — verify
      this concretely (a determined user shouldn't be able to reconstruct
      a hidden home address from the visible route); treat a failure here
      as a security finding, not a UX nitpick, per `security-auditor`.
- [ ] Person's explicit approval.

---

## Phase 6 — Differentiators from Nutrition & Strength apps (UNQ-06 through UNQ-13)

**Scope:** Restaurant-item DB entries, net-carb/keto mode, intermittent
fasting timer, expanded exercise library, community-shared routines, the
initial (human/rule-based, not yet AI-driven) version of daily workout
generation, muscle recovery heatmap, multiple equipment profiles.

**Agents:** `backend-builder` + `db-engineer` → `mobile-builder` →
`ui-ux-designer` → `qa-engineer` → reviewer trio.

**Note:** UNQ-11's daily workout generation ships here as a rule-based/
template version — the full AI-driven version depends on AI-03 and AI-05,
which land in later phases. Don't let this phase's version quietly become
"good enough" and skip the AI upgrade later; treat it as an explicit
placeholder.

**Gate:**
- [ ] Community-shared routines respect ownership/attribution.
- [ ] Person's explicit approval.

---

## Phase 7 — Differentiators from Caliber (UNQ-14, UNQ-15, UNQ-16, UNQ-17)

**Scope:** Real human coach option + in-app messaging, video form review
(escalation path from AI-01, which lands in Phase 9 — this phase builds
the receiving end), weekly structured progress reviews, bundled coaching.

**Note:** This phase has a real operations dependency, not just
engineering — a "human coach" tier needs actual coaches on staff or
contracted. Flag this to the person explicitly before treating the phase
as blocked on engineering alone.

**Agents:** `architect` → `backend-builder` (messaging infrastructure) →
`mobile-builder` → `ui-ux-designer` → `qa-engineer` → reviewer trio.

**Gate:**
- [ ] In-app messaging tested for basic reliability and privacy (a coach
      only sees the clients assigned to them).
- [ ] Person's explicit approval.

---

## Phase 8 — AI Reliability & Trust, Part 1 (AI-13, AI-14, AI-15)

**Scope:** Multi-sensor GPS fusion (upgrades Phase 1's baseline recording),
post-hoc route reconstruction, automated pre-release regression detection.
The spec calls AI-13 its single highest-leverage reliability fix — treat
this phase with matching seriousness, not as routine feature work.

**Agents:** `mobile-ml-engineer` (fusion + reconstruction, per
`on-device-ml-standards`) → `devops-engineer` (regression-detection
telemetry pipeline) → `qa-engineer` → reviewer trio.

**Gate:**
- [ ] **Validated in a real GPS-denied environment** (tunnel, parking
      garage, or equivalent) — not simulated dropout data alone.
- [ ] Battery/thermal impact measured against a stated budget on real
      hardware.
- [ ] Drift-correction behavior on signal return is documented and
      verified, including the defined behavior for a dropout exceeding the
      reasonable bound.
- [ ] Person's explicit approval.

---

## Phase 9 — AI Coach & Personalization, Part 1 (AI-01, AI-02, AI-03)

**Scope:** CV form checking, proactive accountability agent, fast
cold-start personalization.

**Agents:** `mobile-ml-engineer` (AI-01) + `ai-systems-engineer` (AI-02,
AI-03) in parallel → `mobile-builder` (UI integration for both) →
`qa-engineer` (including the labeled evaluation sets required by
`ai-orchestration-standards` and `on-device-ml-standards`) → reviewer trio.

**Gate:**
- [ ] Form-check confidence-escalation verified: a deliberately ambiguous/
      low-confidence input actually routes to the human review path
      (UNQ-15), not a silently-confident wrong score.
- [ ] Form-check tested against real gym conditions (lighting, mirrors,
      partial occlusion), not just clean reference footage.
- [ ] Accountability agent's function-calling scope verified against
      `ai-orchestration-standards` — confirm it cannot take actions outside
      its enumerated scope even under adversarial chat input.
- [ ] Person's explicit approval.

---

## Phase 10 — AI Coach Part 2 & Nutrition AI (AI-04, AI-06, AI-09, AI-10, AI-11, AI-12)

**Scope:** Conversational re-planning, adaptive training load from
recovery signals, AI meal parsing, auto portion estimation, editable
self-correcting logs, auto macro-goal adjustment from synced activity.

**Agents:** `ai-systems-engineer` (AI-04, AI-06, AI-12) +
`mobile-ml-engineer` or `ai-systems-engineer` (AI-09, AI-10 — photo-based
parsing; assign based on whether the chosen approach is on-device or a
cloud vision call) → `mobile-builder` → `qa-engineer` → reviewer trio.

**Gate:**
- [ ] AI-11's editable/self-correcting principle verified concretely on
      every AI-populated field introduced this phase, not assumed from the
      pattern being "already built in."
- [ ] AI-12's macro-goal adjustment verified against Phase 3's
      reconciliation logic — no double-adjustment or conflicting target.
- [ ] Person's explicit approval.

---

## Phase 11 — AI Coach Part 3 & Remaining Reliability/Trust (AI-05, AI-07, AI-08, AI-16, AI-17, AI-19, AI-20)

**Scope:** AI-adapted periodization templates, natural-language Q&A,
predictive logging UX, smart route/segment recommendation, leaderboard
integrity/anti-cheat, wearable data fusion & dedup, review/feedback triage.

**Agents:** `ai-systems-engineer` (all of these are LLM/orchestration or
recommendation-system work) → `mobile-builder` → `qa-engineer` → reviewer
trio.

**Gate:**
- [ ] AI-17 anti-cheat tested against at least one deliberately fabricated
      leaderboard-gaming attempt, not just legitimate data.
- [ ] AI-08 predictive logging latency measured against its stated budget.
- [ ] Person's explicit approval.

---

## Phase 12 — AI-18: Agentic Subscription/Billing Support

**Scope:** AI-18 only. Deliberately last, deliberately the strictest gate
in this document, per the spec's own explicit callout that this is where
convenience and safety are in direct tension.

**Process (this phase's sequence is different from every other phase —
follow it exactly):**

1. `security-auditor` produces a written threat model per
   `billing-agentic-guardrails` — enumerated action list, the check applied
   to each, audit mechanism, rate/amount limits.
2. **Person reviews and approves the threat model before any implementation
   code is written.** This is not a formality — do not proceed to step 3
   without explicit sign-off.
3. `ai-systems-engineer` implements strictly against the approved
   enumerated action list — nothing broader.
4. `qa-engineer` red-teams it adversarially per `billing-agentic-
   guardrails`' testing section (persistence, claimed authority, social
   engineering framings) before the standard test suite is considered
   sufficient.
5. `security-auditor` reviews the implementation against the original
   threat model — flag any drift between what was approved and what was
   built.

**Gate:**
- [ ] Threat model approved by the person before implementation started.
- [ ] Every state-changing action has a deterministic check or explicit
      user confirmation — verified in code, not asserted in a report.
- [ ] Adversarial red-team pass found no way to get an out-of-scope action
      to execute.
- [ ] Audit log verified to actually capture every agentic billing action
      taken during testing.
- [ ] Person's explicit approval.

---

## When the full sequence is complete

All 57 features (20 CORE, 17 UNQ, 20 AI) are built and every phase gate has
passed. Treat this as the point to run `security-auditor` and
`design-reviewer` as full-codebase passes (not diff-scoped) once more
before any public launch, since a system built over twelve-plus phases can
develop drift between early and late decisions that a phase-by-phase review
wouldn't catch — check specifically for consistency in the design token
system across the earliest and latest screens built, and for any RLS
policy that predates a later architectural decision and was never revisited.
