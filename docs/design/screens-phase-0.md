# MileLift — Phase 0 Screen Specs (auth · onboarding · profile · consent)

Status: **v1, implementable.** Consumer: `mobile-builder` (build directly against
this; do not re-derive decisions). Every value referenced here is a named token
from `docs/design/theme.ts` — if you find yourself wanting a literal, that's a
missing token, add it there first.

Scope guardrail: **Phase 0 UI surfaces only** — sign-up, login, onboarding,
profile, and the per-category consent prompts. No dashboard, no activity/
nutrition/strength logging, no data-viz — those are Phase 1–3 and are explicitly
not designed here.

Shared foundations:
- Theme: **dark** (`themes.dark`). Canvas is `bg.canvas`; primary panels
  `bg.surface`; cards `bg.raised`.
- Screen gutter: `screen.edge` (16pt). Content column max ~440pt, centered on
  tablets.
- Touch targets: `touchTarget.min` (44) floor, `touchTarget.comfortable` (52)
  for primary CTAs. Every interactive element has an accessibility label.
- All copy is in the **precise-plainspoken-coach** voice (tokens.md §1). Buttons
  are verbs; confirmations mirror the verb.
- Every screen below specifies loading / empty / error / success where they can
  occur — the unhappy path is first-class (production-standards), not a TODO.

---

## A. Component vocabulary (used across all Phase 0 screens)

Define these once; screens compose them.

- **PrimaryButton** — `accent.primary` fill, `text.onAccent` label
  (`type.bodyStrong`), `radius.md`, height `touchTarget.comfortable`, full-width
  in forms. Pressed → `accent.primaryPressed` + `opacity.pressed`. Disabled →
  `opacity.disabled`, non-interactive. Loading → label swaps to a centered
  spinner (ember-on-dark), button stays sized, control disabled.
- **SecondaryButton** — transparent fill, `border.default` hairline, `text.primary`
  label. Used for "Not now" / non-destructive alternates. **Never** styled tinier
  or lower-contrast than the primary to nudge a choice (no dark patterns —
  especially on consent).
- **TextButton** — no fill/border, `text.secondary` label, used for tertiary
  ("Skip", "Need help?").
- **Field** — label (`type.label`, `text.secondary`) above input; input is
  `bg.inset`, `border.default` hairline, `radius.sm`, `text.primary`
  (`type.body`), min height 48. Focus → `border` becomes `focusRing` at
  `border.thick`. Error → border `feedback.danger`, helper line below in
  `feedback.danger` (`type.caption`). Helper/hint text otherwise `text.tertiary`.
- **MeridianMark** — the signature glyph (tokens.md §6). Variants: `lockup`
  (with wordmark), `progress` (onboarding), `glyph` (small header origin),
  `seed` (origin-only, faint axes, for empty states).
- **InlineBanner** — full-width note, tinted bg (`feedback.*Tint`), leading
  glyph, `type.caption` text. For offline/info/error context that isn't a
  blocking dialog.
- **SyncStatusPill** — small pill showing `Saved` / `Syncing` / `Sync failed`
  (mobile-architecture: visible, not silent). Appears on Profile edits.

---

## B. Sign-up

**Goal:** one account per person (CORE-18). Email/password + Apple/Google, all
funneling into the same `profiles` row (architecture §2 — identity linking; a
second provider on the same verified email must not fork an account).

**Layout (top → bottom):**
1. `MeridianMark:lockup` + wordmark, top-left, below the safe-area inset.
2. Headline `type.displayMd`: **"One log. The miles and the lifts."**
   Sub `type.body` `text.secondary`: "Everything you track, in one history —
   not five apps that never talk."
3. OAuth row: **Continue with Apple**, **Continue with Google** (SecondaryButton
   style with provider glyph; Apple button follows Apple's presentation rules on
   iOS). These are above the email form — the fastest path first.
4. Hairline divider with centered `type.overline` `text.tertiary`: "OR".
5. Fields: **Email**, **Password** (with show/hide toggle, min-length hint as
   `text.tertiary` helper: "At least 8 characters").
6. **PrimaryButton: "Create account"**.
7. Legal line `type.caption` `text.tertiary`: "By creating an account you agree
   to our Terms and Privacy Policy." Terms/Privacy are tappable links.
   **Note:** this general agreement does **not** cover health/location/camera —
   those are separate, per-category, point-of-use consents (health-data-
   compliance; architecture §6). Do not bundle them here.
8. Footer: "Already have an account? **Log in**" (TextButton → Login).

**States:**
- *Idle/validating:* inline field validation on blur — email format, password
  length. "Create account" disabled until both pass client validation.
- *Loading:* PrimaryButton spinner; OAuth buttons disabled during an in-flight
  email submit and vice-versa.
- *Error — email already in use:* field error on Email: "An account already uses
  this email. **Log in instead** or reset your password." (Offer the recovery
  path, don't dead-end.)
- *Error — weak/invalid password:* password field helper turns danger with the
  specific rule that failed, not a generic "invalid".
- *Error — network/offline:* InlineBanner (`feedback.warningTint`): "You're
  offline. Creating an account needs a connection — your login will work offline
  once you're set up." (Honest about the one thing that genuinely can't be
  offline.)
- *Error — server/rate-limit:* InlineBanner (`feedback.dangerTint`): "Something
  went wrong on our end. Try again in a moment." Never expose a raw error.
- *Success:* proceed to Onboarding (§D). No celebratory interstitial.

**Motion:** MeridianMark draws once on first mount (`duration.deliberate`,
reduced-motion → static). Field focus border transitions at `duration.fast`.

---

## C. Log in

Same shell and OAuth row as Sign-up (consistency is the point — one account,
one door).

**Layout:** MeridianMark lockup → headline `type.title` "Welcome back." → OAuth
row → OR divider → **Email**, **Password** → **PrimaryButton: "Log in"** →
TextButton "Forgot password?" → footer "New here? **Create account**".

**States:**
- *Error — wrong credentials:* a single form-level danger line (do **not**
  reveal which of email/password was wrong — that's an account-enumeration leak;
  security-review): "Email or password doesn't match. Try again or reset your
  password."
- *Error — unverified email* (if verification is required): InlineBanner:
  "Confirm your email to finish signing in. We sent a link to {email}. **Resend**."
- *Error — offline:* InlineBanner: "You're offline. We'll log you in as soon as
  you're connected." If a valid local session already exists, the app should
  open to local data and sync later — never a hard wall for an already-signed-in
  user (offline-first).
- *Loading / Success:* as Sign-up.

---

## D. Onboarding

**This is the highest generic-risk surface in the category** (the standards say
so explicitly). We reject all three of its clichés:
**no goal-selection card grid, no progress dots, no permissions carousel.**

Instead: **three short steps, and the signature Meridian IS the progress
indicator** — the user builds the hybrid mark as they go. Consents are
**deliberately not requested here** — they fire at point-of-use later
(architecture §6/§13). Onboarding collects only non-sensitive setup.

Progress indicator: a persistent `MeridianMark:progress` pinned near the top.
- Step 1 complete → the **Mile axis** (horizontal, ember) is drawn ~⅓… then ⅔…
- Step 3 complete → the **Lift axis** (vertical, cyan) rises and the origin
  `spring.settle`s. Finishing onboarding = a fully-built Meridian. The mark's
  completion states the thesis without a word of copy.
- Reduced motion: axes appear in discrete filled segments per step, no drawing.

Global controls: a **Back** affordance (steps 2–3) and, because none of this is
required data, a **Skip for now** TextButton that lands the user in the app with
sensible defaults (metric/imperial inferred from device locale, balance =
"Balanced"). Never trap the user in onboarding.

### Step 1 — Welcome / thesis
- `MeridianMark` draws (origin → short mile axis).
- `type.displayLg`: **"You run *and* you lift."**
  Sub `type.bodyLg` `text.secondary`: "Most apps make you pick one. MileLift
  keeps both in a single history, so your training actually adds up."
- PrimaryButton: **"Set up my training"**. TextButton: "Skip for now".
- No stock photo. Graphite field + the mark carry it.

### Step 2 — Training balance (the differentiated interaction)
Replaces the goal-card grid. **"Where's your training right now?"**
A single horizontal **balance track** (the Mile axis made interactive) with a
draggable origin knob running between two poles:

`Endurance-leaning ——●———————— Strength-leaning`
                     (center = Balanced hybrid)

- The track's warm end is ember, cool end is cyan; the knob is the Meridian
  origin. Dragging it literally sets where warm meets cool.
- A live readout under it uses the **metric face**: e.g. `type.metricMd`
  `70 / 30` with `type.label` "run / lift" — establishing the numeric identity
  on the very first setup screen, and framing training as a measurable balance,
  not a vibe.
- Three snap points labelled (Endurance · Balanced · Strength) for users who'd
  rather tap than drag; the knob also free-drags for finer ratios.
- Copy under: "You can change this anytime — it just tunes what MileLift shows
  first." (Sets expectation: low-stakes, reversible.)
- **Accessibility:** the knob is a proper slider (adjustable role,
  increment/decrement via screen reader, value announced as the ratio). Not a
  drag-only control.
- PrimaryButton: **"Next"**.

Rationale for keeping this: it's the one onboarding interaction that *only*
MileLift would build, because it encodes the hybrid thesis the product is
organized around. It captures nothing sensitive.

### Step 3 — Name & units
Plain, fast, non-sensitive (architecture §2 — these live on `profiles`).
- **Display name** (Field). Helper: "Shown to people you train with."
- **Username** (Field, unique). Live-check availability; success → small Growth
  check + "Available", taken → danger helper "Taken — try another."
- **Units** — two segmented `radius.pill` controls: Weight `kg` / `lb`,
  Distance `km` / `mi`. Default from device locale. Values shown in the metric
  face. (These are copied onto each future record at write time — architecture
  §2 — so the choice is real, not cosmetic.)
- PrimaryButton: **"Finish setup"** → Lift axis rises, Meridian completes, land
  in app.

**What is intentionally NOT in onboarding:** sex, date of birth, height (the
sensitive demographics). Per architecture §12 decision 3, these are collected
**optional, at point-of-use**, never as a signup field. They surface later only
when a feature needs them, behind the health consent (§E) — not here.

**States (onboarding-wide):**
- *Empty/default:* every step has a valid default (locale units, Balanced) so
  Skip always yields a usable account.
- *Error — username check offline:* allow proceeding; validate/uniqueness-check
  on sync, and if it collides then, prompt to pick another on next launch.
  Never block finishing setup on a network call.
- *Success:* first landing in the app. No confetti; the completed Meridian is
  the reward.

---

## E. Consent prompts (health · location · camera)

**This is the Phase 0 surface the architecture flags as a real design problem,
not something to improvise** (§6/§13). Hard rules, applied to all three:

1. **Per-category, never bundled.** Three separate prompts, each with its own
   specific purpose string. There is no "Allow all."
2. **At point of use, not at signup/onboarding.** The prompt appears the first
   time the user does the thing that needs it (see triggers below).
3. **Every prompt states what MileLift does NOT do** — the specific limit is the
   trust-builder.
4. **Two clear, equal-weight choices** — a primary allow and a genuine, legibly-
   styled decline. No tiny grey "no thanks." Declining is a first-class outcome.
5. **This in-app prompt precedes the OS prompt.** It explains *why* first; only
   on "Allow" do we trigger the actual OS permission dialog. This avoids the user
   burning their one OS-prompt on a request they didn't understand (and matches
   Apple/Google expectations for pre-permission priming).
6. **Graceful revocation is designed, not assumed** (architecture §6; health-
   data-compliance). Each category has a denied state, a granted state, and a
   revoked-later state, all non-crashing.

**Shared layout (bottom sheet, `radius.xl`, `bg.raised`, scrim `opacity.scrim`):**
- `MeridianMark:glyph` + a category icon at top.
- Title `type.title` — the plain-language ask.
- Purpose `type.bodyLg` `text.primary` — *what* it's used for and *why*, in the
  user's terms.
- **"What MileLift won't do"** row — leading glyph, `type.body` `text.secondary`
  — the explicit limit.
- PrimaryButton (Allow) + SecondaryButton (Not now), equal weight.
- Footnote `type.caption` `text.tertiary`: where to change it later.

### E1. Health data  (trigger: first time the user connects a wearable / imports
Apple Health / Health Connect, or opens a recovery-aware feature)
- **Icon accent:** `accent.data` (this is the tracking/trust color).
- **Title:** "Connect your health data?"
- **Purpose:** "MileLift can read your workouts, heart rate, and sleep from
  Apple Health / Health Connect so training load and recovery reflect what your
  body actually did — not just what you typed in."
- **Won't do:** "It never shares your health data for ads or sells it — Apple and
  Google forbid it, and so do we. You choose per type what's shared with people
  you train with; nothing is shared by default."
- **Buttons:** "Connect health data" · "Not now"
- **Footnote:** "Turn this off anytime in Settings › Permissions & data. What
  you've already recorded stays; we just stop reading new data."
- **Data minimization note for the builder:** request only the specific
  HealthKit / Health Connect types the triggering feature uses (not a broad
  bundle) — health-data-compliance. The iOS `NSHealthShareUsageDescription` /
  Android rationale strings must match this purpose text.

### E2. Location  (trigger: first time the user starts recording an activity)
- **Icon accent:** `accent.primary` (activity/energy).
- **Title:** "Use location while recording?"
- **Purpose:** "Location maps your route while an activity is recording, so you
  get distance, pace, and the map afterward."
- **Won't do:** "MileLift only uses location during an active recording — never
  in the background between activities, and never to build a profile of where you
  go. You can hide the start and end of any route." (The last clause previews
  UNQ-05 privacy zones — a real safety feature, surfaced as reassurance.)
- **Buttons:** "Allow while recording" · "Not now"
- **Footnote:** "You can record without a map — we'll still count time and any
  data from a connected watch."
- **Builder note:** request **When In Use**, not Always. Requesting Always here
  would contradict the purpose string and fail review.

### E3. Camera  (trigger: first progress photo; later, first form-check video)
- **Icon accent:** `accent.growth` (progress).
- **Title:** "Use your camera for progress photos?"
- **Purpose:** "The camera lets you take progress photos to track how your body
  changes over time." (When the form-check feature ships in a later phase, the
  same prompt gains a second sentence for form-check video — one category, purpose
  text extended, not a new bundled ask.)
- **Won't do:** "Progress photos are private to your account and stored
  encrypted — they're never shown in any feed and never shareable. Only you can
  see them."
- **Buttons:** "Allow camera" · "Not now"
- **Footnote:** "You can also add a photo from your library instead. Change camera
  access anytime in Settings."
- **Builder note:** progress photos are `visibility = private` and
  **non-widenable** (architecture §1.3) — the "never shareable" copy is a
  hard system guarantee, not marketing.

### Consent states (all three categories)
- **First ask (priming sheet):** as above.
- **Allowed:** dismiss sheet, proceed to the action; write the `user_consents`
  row (category, purpose_version, granted_at — architecture §6). Confirmation
  mirrors the verb, e.g. toast "Health access on."
- **Declined ("Not now"):** the triggering feature degrades gracefully with a
  specific inline explanation + a one-tap re-ask, **never** a crash or a dead
  screen. Examples:
  - Health declined → recovery/load features show `MeridianMark:seed` empty
    state: "Connect health data to see recovery-adjusted load. **Connect**."
  - Location declined → recording still runs on time + watch data; map area shows:
    "No route without location. Recording time and heart rate instead. **Turn on
    location**."
  - Camera declined → "Add a progress photo from your library, or **turn on the
    camera**."
- **OS-denied (user allowed in-app, denied at OS):** detect and show a one-time
  InlineBanner routing to OS Settings: "Camera is off in your phone's Settings.
  **Open Settings**." Don't loop the in-app prompt against an OS block.
- **Revoked later (from OS or in-app):** processing for that category stops
  immediately; set `revoked_at` on the consent row; purge/stop using data per the
  category. The dependent feature falls back to its declined state above. **No
  stale authorized data is used after revocation** (health-data-compliance;
  architecture §6). This is surfaced in Profile › Permissions & data (§F).

---

## F. Profile

The single unified profile (CORE-18) and the home for **consent management +
graceful revocation** — the architecture requires revocation to be a real,
usable surface, and this is it.

**Sections (each anchored by a `MeridianMark:glyph` header):**

1. **Identity** — avatar (tap to change → triggers Camera consent E3 or library),
   `display_name`, `@username`, `type.title` name + `type.body` handle. Edit
   inline; edits show `SyncStatusPill` (Saved → Syncing → Synced), so the user
   can trust it persisted (offline-first).
2. **Training balance** — shows the Step-2 ratio in the metric face
   (`70 / 30`, "run / lift") with the mini balance track; tap to adjust. Same
   control as onboarding.
3. **Units** — Weight kg/lb, Distance km/mi segmented controls (metric face
   values). Changing units changes display only; historical records keep the unit
   they were logged in (architecture §2).
4. **Health details (optional)** — sex, date of birth, height. **Clearly marked
   optional and consent-gated** (architecture §12.3 / §6). Collapsed by default
   with copy: "Optional. Add these only if you want more accurate calorie and
   recovery estimates — they're stored privately and never shown to anyone."
   Adding any field requires the health consent (E1) and writes to the separate
   `profile_health` table, never `profiles`. Each field individually skippable
   and later editable/removable (correction right, health-data-compliance).
5. **Permissions & data** — one row per consent category (Health · Location ·
   Camera), each showing current state with a toggle:
   - *On* → `accent.growth` state chip "On", with the granted purpose; toggling
     off triggers a **revocation confirm**: "Turn off location? Recording will
     stop mapping routes. What you've already saved stays." → on confirm, sets
     `revoked_at`, stops processing (graceful revoke).
   - *Off* → neutral chip "Off"; toggling on re-runs the priming sheet (E).
   - *Blocked at OS* → chip "Off in Settings" + "Open Settings" link.
   Below the rows: **Export my data** and **Delete account** (TextButtons).
   - *Export* → "We'll gather your full history and email you a download link."
     (Real code path — architecture §7 — not a support ticket.)
   - *Delete account* → destructive confirm sheet naming the consequence: "This
     permanently deletes your account and everything in it — activities,
     nutrition, workouts, photos — within 30 days. This can't be undone." The
     confirming button uses `feedback.dangerSolid` fill with `text.onDanger`
     (white) — the AA-safe danger fill, not `feedback.danger` (which is the
     text/border danger and fails contrast under a white label). Requires typing
     the word or a second confirm. (Cascades per architecture §7/§12.2.)
6. **Account** — email, sign-in method(s), **Log out** (SecondaryButton).

**States:**
- *Loading:* skeleton rows (`bg.raised` blocks), not a blank screen.
- *Offline edit:* edits apply locally, `SyncStatusPill` shows "Saved · will sync";
  never blocks editing (offline-first).
- *Sync failed:* pill shows "Sync failed · retry" with a tap-to-retry; the local
  value is preserved, not lost.
- *Error — username taken on sync:* revert with a specific prompt to choose
  another; don't silently drop the change.
- *Empty health details:* `MeridianMark:seed` + the optional explanation, not a
  set of empty required-looking fields.

**Destructive-action rule:** delete and revoke both name the specific consequence
in the user's terms and use `feedback.danger` only on the confirming action, not
the entry point — no accidental taps, no dark-pattern hiding of the safe choice.

---

## G. Handoff checklist for `mobile-builder`

- All colors/spacing/type/motion come from `theme.ts`. No literals in components.
- Font loading: `@expo-google-fonts/{archivo,inter,jetbrains-mono}` with the
  exact weight identifiers in `theme.ts › fontFamily`; apply `fontVariation.display`
  to display Text and `fontVariation.metric` to all numeric Text.
- `MeridianMark` is one component with the four variants named in §A; implement
  the draw with Reanimated, gated on `AccessibilityInfo.isReduceMotionEnabled()`
  (static fallback per tokens.md §5).
- Consent flow writes `user_consents` rows (category, purpose_version, granted_at
  / revoked_at) per architecture §6; the priming sheet precedes the OS prompt;
  request the minimum scope per category (§E builder notes).
- Every interactive element: `≥ touchTarget.min`, an accessibility label, a
  visible `focusRing` focus state, and a non-color secondary signal on any
  status conveyed by color.
- Unhappy paths in §B–§F are requirements, not optional polish — offline, error,
  denied, revoked, and OS-blocked states each have specified copy above.
