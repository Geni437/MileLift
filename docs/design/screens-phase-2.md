# MileLift — Phase 2 Screen Specs (Module C · Strength Training & Workout Logging)

Status: **v1, implementable — all design decisions settled (see §Decisions,
2026-07-21).** Consumer: `mobile-builder` (build directly against this; do not
re-derive decisions). This **extends** the Phase 0 + Phase 1 system —
every value is a named token from `docs/design/theme.ts`, every screen inherits the
Phase 0 component vocabulary (`screens-phase-0.md §A`), the Phase 1 additions
(`screens-phase-1.md §A`), and the precise-plainspoken-coach voice (`tokens.md §1`).
If you want a literal, that's a missing token — add it to `theme.ts` first.

Covers CORE-12 … CORE-17 UI, designed against `docs/architecture/phase-2-module-c.md`
(the CONFIRMED data model; §-refs below are to that doc unless prefixed `P0`/`P1`)
and the live RPC contract `docs/api/save-workout-session-v1.md` (`RPC` refs below).

Scope guardrail: **Module C UI only** — active workout logging + rest timer
(CORE-12), the exercise library browse/search/filter + custom-exercise creation
(CORE-13), the workout-template & program builder (CORE-14), workout history/detail +
strength PRs + progression analytics (CORE-15), progress: bodyweight, measurements,
and the `body_image`-gated progress photos (CORE-16), and offline sync-status
treatment throughout (CORE-17). **Not** in scope (built so the surface doesn't look
broken by their absence): AI form-check / video player (Phase 9 — video is "coming
soon" only, never a player state, §2/§13), community-shared templates/routines
(Phase 4 widening, §12), program calendar-scheduling & auto-progression engine
(later — we ship the builder data model + starting a workout from a template, not a
scheduler, §11), the cross-module unified Home dashboard (still a Phase-1-deferred
Home concern — a strength session IS a `timeline_events` row and *will* join the
unified timeline there; in Phase 2 its history lives under the Lift tab, §B).

---

## 0. Why this phase looks the way it does (the one idea)

Phase 0 established the **Mile ↔ Lift duality** and the **Meridian** signature: a
warm **horizontal** Mile axis (ember, distance-over-time) meeting a cool **vertical**
Lift axis (cyan, load-against-gravity) at an origin. Phase 1 made the **Mile axis a
working instrument** — a recorded run *draws* the horizontal ember `MeridianTrace`.

**Phase 2 is the exact mirror: Module C makes the vertical Lift axis a working
instrument.**

> **A completed set raises the Lift axis.** Where a recorded run draws the horizontal
> ember trace left-to-right, a logged workout **stacks completed working sets into a
> rising vertical cyan column** — the `LiftStack`. Each working set adds a segment
> whose height is its volume (reps × weight); the whole column is the session's shape
> — a warmup ramp, the top sets, a dropset taper — and its total height is the
> session volume. When a set beats your record, its segment **flares ember and rises
> past a marked previous-best line**, the identical PR language Phase 1 used on the
> Mile axis, turned vertical. One motif — logo → live screen → PR moment → history
> row → progression chart — carried by the app's own axis, not a borrowed pattern.

This is the deliberate answer to strength-logging's single biggest cliché, chosen on
purpose, not defaulted into:

- **Not the strength-app spreadsheet as the whole identity.** Every competitor
  (Strong, Hevy, Jefit) *is* a grid of `[set | prev | kg | reps | ✓]` and nothing
  else. That grid is genuinely the best **input** ergonomic and we keep it, clean and
  quiet — but the session's **shape, progress, and completion moment** live in the
  `LiftStack`, which is unmistakably MileLift and which no spreadsheet-only app has.
- **Not a circular progress ring** for anything (the category's most-copied cliché,
  ruled out in `tokens.md §7`) — the hero is the vertical axis, the Lift half of the
  brand made real.
- **Not a generic green checkmark** for a completed set — completing a set *builds
  the Lift axis*, the single interaction this brand is organized around.

In a future unified timeline, runs render as horizontal ember traces and lifts as
vertical cyan stacks — instantly distinguishable at a glance, both unmistakably
Meridian. That legibility payoff is the thesis ("one log, the miles and the lifts")
made visual.

---

## A. New component vocabulary (Phase 2 adds these; compose, don't re-style)

Defined once here; screens below reference them. All inherit Phase 0 §A / Phase 1 §A
patterns. Numbers everywhere use the **metric face** (`fontVariation.metric`,
tabular) — non-negotiable, it is the app's content (`tokens.md §3`).

- **LiftStack** — the signature applied to strength. A **vertical** cyan
  (`accent.data`) column anchored at a **bottom origin dot** (`text.primary`), the
  Lift axis being raised. It is the vertical companion to Phase 1's `MeridianTrace`.
  - `live` variant (active logging): a **slim vertical rail** pinned to the screen's
    right edge; each **completed working set** stacks a new segment upward, segment
    height ∝ that set's volume (`reps × weight_kg`; for bodyweight/time movements,
    ∝ reps or duration). Warmup/failed/incomplete sets do **not** stack (they don't
    count to volume — §4.1). A faint horizontal **previous-best tick** marks the
    current exercise's prior best est-1RM/heaviest. Grows as you log — it is **not**
    a fill-to-100% bar (a workout has no fixed target); it is a living axis. Tapping
    it expands a "session so far" summary (volume, sets, per-exercise breakdown).
  - `static` variant (session detail hero / history-row micro): renders the finished
    session's column, segments grouped and tinted per exercise, PR segments flared.
  - `empty`/first-set: the bottom origin dot + a faint vertical baseline only.
  - PR treatment: the segment that set a record **flares ember** (`accent.primary`
    glow via shadow, no new color — reuses the Phase 1 PR language, `tokens.md §2.1`)
    and visibly **rises past the previous-best tick**.
  - Reduced motion: segments appear in place without the rise easing (that's the same
    rule as `MeridianTrace` — the endpoint/data updates, the decoration doesn't).
- **RestTimer** — the CORE-12 between-sets countdown, a **first-class** surface (one
  of the module's defining features, not an afterthought). A **horizontal** track
  that **depletes right→left toward the origin** — the one live moment where Mile-time
  and Lift-load meet (a horizontal *time* rest inside a vertical *load* session). Uses
  the `color.restTimer` alias group (`tokens.md §2.2`): `restTimer.fill` (cyan)
  running, `restTimer.ending` (gold) in the final ~10s, `restTimer.done` (growth) at
  zero. The remaining time is a `MetricStat` (`type.metricLg`) — big and glanceable
  one-handed. Controls: **−15s** / **+15s** and **Skip**. Non-color signal at every
  state (numeric readout + label "Rest" / "Rest done" + a haptic at zero), never
  color alone. Pinned to the bottom safe area while running (thumb reach, doesn't
  cover the sets you're resting between). See §CORE-12 for behavior + background
  notification.
- **SetRow** — one set in an `ExerciseBlock`. The clean, functional input grid (the
  deliberate restraint — this is the mid-set, one-handed, sweaty-hands surface;
  legibility ranks above every decorative choice, per the standards). Columns are a
  **function of the exercise's metadata**, never hardcoded: `is_weighted` →
  Weight + Reps; `is_bodyweight` → Reps (+ optional added kg); `is_time_based` →
  Duration; `is_distance_based` → Distance (+ Duration). Layout left→right:
  **set index / `SetTypeTag` · "prev" reference · [metadata fields, metric face] ·
  complete toggle.** The **complete toggle IS the signature moment** — see §CORE-12.
- **SetTypeTag** — a compact non-color glyph+label for `set_type`
  (`working`/`warmup`/`dropset`/`failure`/`amrap`). Working = plain set index number;
  the rest carry a distinct short glyph + `type.overline` label (`W`up, `D`rop, `F`,
  `AMRAP`) so type is never color-only. Warmups render de-emphasized (`text.tertiary`)
  because they're excluded from volume/PR (§4.1).
- **ExerciseBlock** — one exercise within a session or a plan. Header: static
  thumbnail (from `exercise_media` primary image, or a `MeridianMark:glyph` fallback),
  `exercise_name_snapshot`, a `MuscleTag`, a drag handle, and an overflow (reorder /
  remove / add note / superset link / swap). Body: the `SetRow`s + an **Add set** row.
  Two modes: **log mode** (logged values + complete toggles + rest, §CORE-12) and
  **plan mode** (target sets / target rep-range / target weight / target rest, no
  toggles, §CORE-14) — same component, different row content.
- **ExerciseRow** — one library movement in a list: small static thumbnail, `name`,
  `MuscleTag` + `EquipmentTag` (`type.overline`). A scannable list row, **not** a
  card in a grid — the demo images are the differentiator, the layout stays quiet.
- **MuscleTag / EquipmentTag** — `type.overline` pills (`bg.inset`, `text.secondary`)
  for `primary_muscle` / `equipment`. Not brand-colored (metadata, not status).
- **WorkoutRow** — one session in the Lift history timeline: title + relative
  date/time, a compact `MetricBar` (Volume · Sets · Duration), a `LiftStack:static`
  micro-thumbnail (the session's column shape, the vertical counterpart to
  `ActivityRow`'s `MeridianTrace:static`), a `PrBadge` when it earned achievements,
  and a `SyncStatusPill` when not yet synced.
- **RecordRow** (strength) — one cumulative strength PR: metric label
  (`type.overline`), value in the metric face (`type.metricLg`, in `unit_snapshot`),
  a `text.tertiary` "· {relative date}", tappable to the session that holds it
  (`strength_records.timeline_event_id`). A thin **vertical** cyan Lift-axis bar sits
  behind the value as the "record bar" motif — the deliberate vertical counterpart to
  Activity Records' horizontal ember bar (`screens-phase-1.md §CORE-04`).
- **ProgressionChart** — the CORE-15 exercise-over-time viz (from
  `get_exercise_progression_v1`). **Not a default chart-library line** — it is the
  Lift axis over time: one **vertical column per session** (height ∝ est-1RM or
  session-volume-for-that-exercise, toggleable), the current-PR column flared ember,
  a faint rising trend baseline. Gaps (missed sessions) are honest spacing on the
  time axis, never interpolated. See §CORE-15 for the muscle-volume counterpart.
- **PhotoTile** — a progress-photo thumbnail, **privacy-blurred by default** (tap to
  reveal), with a lock glyph — so a glance at your phone in a gym never exposes body
  imagery (health-data-compliance; §CORE-16).

Reused verbatim (do **not** re-style): `MetricStat` / `MetricBar` / `WeekHeader` /
`PrBadge` / `PrCallout` (Phase 1 §A), `SyncStatusPill` (Phase 0 §A — extended with
one new state, §CORE-17), `ConsentSheet` (Phase 0 §E), `MeridianMark` (all variants),
`Field` / `PrimaryButton` / `SecondaryButton` / `TextButton` / `SegmentedControl` /
`InlineBanner` (Phase 0 §A).

---

## B. Navigation & app-shell changes (`app/(app)/_layout.tsx`)

Phase 1 shipped **Home · Activity · Profile** (three text labels, no invented icon
set — a standing discipline). Phase 2 keeps that discipline and adds one tab:

- **Tabs become: Home · Activity · Lift · Profile** — four text labels, no new icon
  set. The new tab is named **"Lift"** deliberately — it is the brand's own word
  (`Mile` + `Lift`) and this phase's entire visual thesis is the Lift axis made real.
  (Mild asymmetry with the "Activity" tab, which is the Mile side but isn't named
  "Mile"; a future rename of Activity → a Mile-side word is flagged, not done here.)
  Home stays the Phase 0/1 placeholder — the real cross-module dashboard, where runs
  and lifts share one timeline, remains explicitly out of scope (§0 scope guardrail).
- **Lift tab** (`app/(app)/lift.tsx`) is **history-first**, exactly mirroring the
  Activity tab: a segmented header **Log | Records** (`SegmentedControl`, `radius.pill`
  — the same component). `Log` is the workout history timeline (§CORE-15); `Records`
  is the strength-PR list (§CORE-15). Directly under the segment sits a lightweight
  **entry row** of `TextButton`s — **Plans · Body · Exercises** — the homes for the
  builder (§CORE-14), progress/biometrics (§CORE-16), and library browse (§CORE-13).
  (Rationale, §Decisions 2: Module C has more top-level surfaces than Module A;
  rather than cram them into 4+ segments or an icon-grid hub the standards warn
  against, history stays the body and the other surfaces are quiet named links.)
- **Start a workout** launches as a **FAB**, bottom-right of the Lift Log,
  thumb-reachable one-handed — an `accent.primary` circle carrying the **Meridian
  origin glyph** (the same FAB pattern as Activity's record button, `screens-phase-1.md
  §B` — a defined glyph, not a new icon). a11y label "Start a workout." Tapping opens
  a **Start sheet**: **Empty workout** · **From a template ▸** (lists the user's
  templates; picking one prefills the logging screen, §CORE-14) · **Resume** (only if
  an in-progress session exists in local SQLite, §CORE-17).
- **Active logging** is a **full-screen modal route** (`app/(app)/workout.tsx`,
  presented modally, **keep-awake**) — a single immersive task, not a place you
  browse to. It owns the status bar and blocks the tab bar while active (identical
  posture to the recording screen, `screens-phase-1.md §B`).
- **Session detail** is a pushed route `app/(app)/workout/[id].tsx`. **Library**
  (`app/(app)/exercises.tsx`, with a modal *picker* mode), **exercise detail**
  (`.../exercises/[id].tsx`), **Plans** (`.../plans.tsx` + template/program builders),
  and **Body** (`.../body.tsx` + `.../body/photos.tsx`) are pushed/modal routes.
  `mobile-builder` owns exact route mechanics.

---

## CORE-12 — Active workout logging + rest timer (`app/(app)/workout.tsx`) — the core

The **highest-frequency, fastest-path, most-glanced** screen in the module (logging
speed is a top churn lever per the spec) — treated with the same care Phase 1 gave
the recording screen. **Legibility and the numeric face rank above every decorative
choice here.** It is a single continuous session you add exercises and sets to, with
a rest timer between efforts and a finish/save at the end. States below: **Empty →
Logging → Resting → Finishing/Save.**

### Layout (Logging state, top → bottom)
1. **Top bar (pinned):** the session **title** as a tappable chip (opens rename;
   default from time-of-day + type, e.g. "Evening Lift"), a **session clock** in the
   metric face (`type.metricMd`, the spine `duration_seconds` — always counts up from
   start), a **`SyncStatusPill`** in its `local` state ("Saved on device", §CORE-17 —
   the offline-safety reassurance, present from the first set), and a **Finish**
   `TextButton` (right).
2. **Exercise list (the body, scrollable):** a stack of **`ExerciseBlock`**s in
   `exercise_order`. Each block:
   - **Header:** thumbnail · `exercise_name_snapshot` · `MuscleTag` · drag handle ·
     overflow (Reorder / Remove exercise / Add note / Superset / Swap exercise).
   - **`SetRow`s** — the clean input grid (metadata-driven columns, §A). Each row:
     `SetTypeTag`/index · a **"prev" reference** (last session's same set index for
     this exercise, `text.tertiary` metric face — a major logging-speed aid) · the
     input fields (metric face) · the **complete toggle**.
   - **Add set** row — duplicates the last set's values as the default (logging
     speed); a long-press opens set-type (warmup/dropset/failure/amrap).
   - When a set is completed and the exercise has a rest target (or the user taps
     **Rest**), the `RestTimer` starts (§Rest timer below).
3. **`LiftStack:live` rail** — the signature, a **slim vertical rail pinned to the
   right edge** of the content, full height, rising from the bottom origin as working
   sets complete (§A). Deliberately slim here (identity + peripheral progress, not the
   primary data — the grid is the primary data); it becomes the **hero** on the Save
   sheet and session detail, which is the right place to spend the boldness. Tapping
   it expands the "session so far" summary.
4. **Bottom action bar (pinned, thumb reach):** **＋ Add exercise** (opens the library
   picker, §CORE-13) + **Finish**. While a rest timer runs, the `RestTimer` takes over
   this bar (it is the thing you're looking at between sets).

### The completion moment (the signature interaction — spend care here)
Completing a set is **not** a generic green checkmark. On tap of the complete toggle:
- the set's values **lock** (become read-only until re-tapped),
- the row gets a **cyan left-border** + the toggle fills with a **check glyph** (the
  non-color signal), and the row de-emphasizes to "done" (`text.secondary`),
- a **new cyan segment stacks onto the `LiftStack` rail** (rises from the current top,
  height ∝ this set's volume) — the Lift axis literally grows by this set. A crisp
  `duration.fast` rise + a light haptic. Reduced motion: the segment appears in place,
  no rise easing.
- if this set beats the exercise's cached record (optimistic on-device check against
  the local `strength_records` mirror, §CORE-17), its segment **flares ember and rises
  past the previous-best tick**, and a compact inline `PrBadge` appears on the row
  ("New best"). The authoritative PR list is reconciled from the RPC at save (§CORE-15).

This is the one place the whole strength module is meant to be remembered by, and the
answer to "why does this not look like every other logging app."

### Add / remove / reorder exercises mid-workout (CORE-12 requirement)
- **Add:** ＋ Add exercise → the library **picker** (search/filter, multi-select,
  §CORE-13) → appends `ExerciseBlock`(s) at the next `exercise_order`.
- **Reorder:** drag handle on the block header (long-press to lift). **Accessible
  alternative required** (not drag-only, mirroring the onboarding-slider discipline
  P0 §D): the overflow menu carries **Move up / Move down** with value announcements.
- **Remove:** overflow → Remove. If the block has **completed** sets, confirm naming
  the consequence: *"Remove Bench Press and its 3 logged sets? The sets are deleted
  from this workout."* On confirm, those sets **tombstone via `deleted_at`** in the
  next save payload — **never** dropped by omission (RPC §2.1: upsert-present,
  never delete-omitted — this is the offline-safety invariant).
- **Superset:** overflow → Superset links two adjacent blocks (shared adjacent
  `exercise_order`s, §1.5). A light cyan bracket ties them; rest is shared. (A minimal
  treatment — deep superset choreography is flagged as a nice-to-have, not required.)
- **Swap exercise:** replaces the *plan* choice **only for sets not yet logged** — an
  already-logged set's exercise reference is immutable (RPC §2.3: "to genuinely change
  it, tombstone the set and create a new one"). The UI enforces this: swap on a block
  with completed sets tombstones nothing, it just changes which exercise *new* sets
  are logged against, and warns if completed sets exist.

### Rest timer (CORE-12 — first-class, §9.5)
- **Auto-start:** completing a set with a rest target (`target_rest_seconds` from the
  template, else a per-exercise or global default) auto-starts the `RestTimer` in the
  bottom bar. A global **"Auto-rest"** toggle (in the workout overflow) turns this off.
- **Running:** the horizontal track depletes right→left; remaining time
  `type.metricLg` (`restTimer.fill` cyan). **−15s / +15s / Skip** controls, all
  ≥ `touchTarget.min`.
- **Final ~10s:** track shifts to `restTimer.ending` (gold), the number pulses
  (reduced motion: no pulse — color + label change only). Non-color signal: label
  reads the count.
- **Done (0):** track flares to `restTimer.done` (growth) back to the origin, a
  distinct **haptic**, label → **"Rest done"**; auto-dismisses after a beat or on the
  next set tap. `rest_seconds_actual` is written to the just-completed set (§9.5).
- **Backgrounded / screen locked:** the timer **fires a local notification** at zero
  ("Rest done — next set up.") — you put the phone down between sets, it must reach
  you (`mobile-builder` wires the notification; the timer is pure client state, no
  network, §9.5).
- **Offline:** entirely client-side; its only persisted footprint is
  `rest_seconds_planned` / `rest_seconds_actual` on the set (§9.5). Works in airplane
  mode with zero degradation.

### The Save sheet (Finish flow)
Opens from **Finish**. A bottom sheet (`radius.xl`, `bg.raised`):
- **`LiftStack:static` hero** — the whole session's column, segments grouped/tinted
  per exercise, PR segments flared. This is where the signature goes big.
- **Summary `MetricBar`** (recomputed final): **Volume** (`total_volume_kg`) · **Sets**
  (`total_sets`) · **Duration** · **Load** (`load_score`, shown only if RPE given).
- **Session RPE** — an adjustable 0–10 control (CR-10 scale, proper slider role with
  value announcement), readout in the metric face. Feeds `load_score` (`RPC §2.7`).
  Optional — a NULL RPE is valid and simply doesn't contribute to load.
- **Title** Field (pre-filled, editable). Optional **Notes**.
- **`PrCallout`(s)** — reuse the Phase 1 PR language, strength variant: *"Heaviest
  Back Squat yet — 105 kg, +5 kg over your last best."* Multiple metrics stack
  (Heaviest · Est. 1RM · Best-set volume · Max reps), each with its delta from
  `strength_records.previous_value`. First-ever of an exercise: *"First Back Squat on
  record — 100 kg."* (no "+delta", no comparison to zero). **No confetti, no medal,
  no trophy** (`tokens.md §7`) — the LiftStack flare + the specific number is the
  reward.
- Primary: **"Save workout."** Confirmation mirrors: **"Workout saved."**
- Secondary: **"Discard"** — destructive, `feedback.dangerSolid` confirming button,
  names the consequence: *"Discard this workout? Every set you logged is deleted and
  can't be recovered."* No accidental discard.

### States
- **Empty (just started, no sets):** the exercise list is empty; a `MeridianMark:seed`
  + copy *"Add your first exercise to start logging."* + the ＋ Add exercise CTA. The
  `LiftStack` shows origin-only. The session already exists durably in local SQLite
  (§CORE-17) — the top-bar pill reads "Saved on device" even before the first set.
- **Logging offline (the norm, the gate test):** everything works; the pill holds
  "Saved on device." **Save is never blocked on network.** On Finish the session
  saves locally immediately, appears in the Lift Log with "Saved · will sync," and the
  `save_workout_session_v1` call + PR reconcile run on reconnect, idempotently (two
  grains: session `id` + per-set `id`, RPC §2.1). The gate's #1 test — *log a full
  workout in airplane mode, reconnect, exactly one synced copy* — is designed into
  this flow: every write is `INSERT … ON CONFLICT (id) DO UPDATE`, retries are safe.
- **Crash / app killed mid-workout → recovery:** the in-progress session is durable
  layer-2 local state (§9.1/§9.3), so on relaunch the **Start sheet** offers **Resume**
  (restores exercises, sets, clock, and the LiftStack) or **Discard**. First-class
  unhappy path, not optional.
- **Rest-timer edge:** if the app was backgrounded past a rest's end, on return the
  timer shows "Rest done" (it doesn't silently keep counting a stale negative).
- **Save error (on later sync):** the row's `SyncStatusPill` shows "Sync failed ·
  retry"; the session and every set are preserved locally, never dropped. Tap retries
  the same idempotent call.
- **Consent — calorie estimation:** if the user opts into estimated calories
  (`calories_source = 'estimated'`) without an active `health` consent, the RPC returns
  `CONSENT_REQUIRED_HEALTH`; surface the **E1 health `ConsentSheet`** (priming, precedes
  any OS/HealthKit ask, P0 §E) — never a raw error. Declining keeps the workout fully
  saveable with `calories_source = 'none'` (no calories, valid).
- **Success:** sheet dismisses to the session detail (or Lift Log), the new row at top.

### Motion
- The `LiftStack` segment rise + PR flare are the earned moments (a set completed, a
  record beaten) — reserved, not decorative. Rest-timer pulse only in its final
  seconds. Hero-metric/clock update continuously (data, not decoration).
- Keep-awake while logging. Reduced motion: no LiftStack rise easing, no rest pulse,
  no PR flare animation (the flare renders as a static ember segment) — values,
  segments, and the PR badge still appear.

---

## CORE-13 — Exercise library, search/filter, custom exercises (`app/(app)/exercises.tsx`)

The **1,699 real movements** now live in `exercises` (+ `exercise_media` static
images). Two modes on one screen: **browse** (standalone, from Lift → Exercises) and
**pick** (modal, when adding to a workout or a template — returns the selection).

### Browse / search / filter
- **Search** bar pinned top (searches `name`). **Cursor-paginated, never unbounded**
  (§5) — a subtle bottom loader on scroll, "That's every match." at the true end.
- **Filters:** **Muscle** (the `muscle_group` enum) and **Equipment** (the
  `equipment_type` enum), as a filter row of `radius.pill` chips opening a filter
  sheet for the full list; selected filters stay visible as removable chips. A
  **"My exercises"** filter surfaces the user's `custom_exercises`.
- **Default (no search) = grouped by muscle** — collapsible groups
  (Chest · Back · Quads · …), mirroring the Activity `TypePicker`'s grouped catalog
  (`screens-phase-1.md §CORE-01`). Each group lists **`ExerciseRow`**s (thumbnail +
  name + `MuscleTag`/`EquipmentTag`). A **scannable list, not a card grid** — the real
  demo images are the differentiator; the layout stays quiet.
- **Offline:** the library is a read-only cached SQLite mirror (§9.1), so search +
  filter + logging work fully offline. Thumbnails degrade to a `MeridianMark:glyph`
  placeholder if an image asset isn't cached/loadable (§10 — a demo image is never on
  the critical path of logging a set).

### Exercise detail (`app/(app)/exercises/[id].tsx`)
- Larger static image (`exercise_media` primary; if a movement's only media is a
  future `video`, show the image + a quiet **"Video coming soon"** tag — **never** a
  player state, §2/§13). `name`, primary + secondary muscles, equipment, mechanic,
  force vector, and `instructions`.
- **Attribution line** (bottom): source + license (e.g. "From wger · CC-BY-SA 4.0")
  — **this ships in-app, it is a licensing requirement, not optional** (§6, §12.1).
  A **"Exercise data credits"** link routes to the credits screen (below).
- Action: **Add to workout** (pick mode) / **Log this** (starts a workout with it).

### Custom exercise creation (CORE-13)
- Entry points: a **"＋ Create custom exercise"** row at the top of browse, and — the
  differentiated moment — a **search empty state**: *"No match for 'Zercher carry.'
  Create it as a custom exercise?"* → prefills the name.
- **Form** (`Field`s, plain and fast): **Name**; **Primary muscle** (picker,
  optional); **Equipment** (picker, optional); and — instead of exposing raw booleans
  — a friendly **"What does a set track?"** choice that maps to
  `is_weighted`/`is_bodyweight`/`is_time_based`/`is_distance_based`: **Weight & reps**
  / **Reps only (bodyweight)** / **Time** / **Distance**. Optional **Notes**.
- **Owner-only, offline-first:** client-generated UUID, saved to local SQLite, works
  in airplane mode; `SyncStatusPill` on the row. Appears immediately under **My
  exercises** and is loggable at once.
- Confirmation mirrors the verb: **"Custom exercise saved."**

### Exercise data credits (`app/(app)/exercise-credits.tsx`)
A plain credits/attribution surface (reachable from library + from exercise detail),
listing the sources and their licenses — **Free Exercise DB** (public domain),
**wger** (CC-BY-SA 4.0, with the share-alike notice), **MileLift-authored**. This is
the in-app realization of the §6/§12.1 "attribution actually ships" gate item, matching
how Module B ships nutrition-source attribution. Copy is plain and factual, not
marketing.

### States
- **Loading:** skeleton `ExerciseRow`s under a skeleton group header (reuse Phase 0
  skeleton), not a spinner on blank.
- **Search empty:** the create-custom CTA above (an invitation to act, not "No
  results").
- **Filter empty:** *"No movements match those filters."* + a one-tap **Clear
  filters**.
- **Offline, image missing:** name + `MeridianMark:glyph` placeholder; the row stays
  fully usable (§10).

---

## CORE-14 — Workout template & program builder (`app/(app)/plans.tsx`)

Owner-owned reusable definitions (not events, §1.7/§1.8). Phase 2 ships the **builder
+ starting a workout from a template**, and the **program data model + associating
templates to schedule slots** — **not** a calendar/auto-progression engine (§11): the
UI must not imply a scheduler that doesn't run yet.

### Plans landing
Segmented **Templates | Programs** (`SegmentedControl`).
- **Templates:** a list of the user's `workout_templates` (name, exercise count, a
  `LiftStack:static`-style micro of the planned shape). **＋ New template.**
- **Programs:** a list of `programs` (name, `length_weeks`, template count). **＋ New
  program.**

### Template builder (`app/(app)/plans/template/[id].tsx`)
- **Name** (Field, required), optional **Description**.
- An ordered list of **`ExerciseBlock`s in *plan mode*** (§A): add from the library
  picker, reorder (drag + accessible Move up/down), each with **target sets**, a
  **target rep range** (`target_reps_low`–`target_reps_high`, a dual readout in the
  metric face, e.g. `8–12`), optional **target weight**, and **target rest**. No
  complete toggles, no logged values — a template is a live plan the user edits
  deliberately (**no snapshot here**; the snapshot happens when a *session* is logged
  from it, §3).
- **"Start workout from this template"** is the payoff — prefills the logging screen
  (§CORE-12) with the planned exercises and target sets/reps/rest, snapshotting the
  template name onto the session (`template_name_snapshot`, §3).
- Save → owner-owned, offline-first, `SyncStatusPill`. Delete → soft-delete
  (`deleted_at`); confirm names that history is untouched (*"Delete this template?
  Workouts you've already logged from it stay in your history."* — the FK is
  SET NULL / snapshot-safe, §1.4).

### Program builder (`app/(app)/plans/program/[id].tsx`)
- **Name**, optional **Description**, optional **Length (weeks)**.
- **Associate templates to slots:** a list of `program_workouts`, each tying a
  template into a **Week / Day** slot (`week_number` / `day_number` / `sort_order`),
  e.g. "Week 1 · Day 1 — Push A." Add a slot → pick a template → set week/day.
  Reorderable. Presented as a **schedule *list*, deliberately not a live calendar** —
  because Phase 2 has no scheduling engine, a calendar grid would imply auto-advancing
  days that don't work yet (§11). A one-line note states it plainly: *"Programs
  organize your templates. Scheduling and auto-progression are coming — for now, start
  any day's workout yourself."*

### States
- **Empty (no templates):** `MeridianMark:seed` + *"Build a template once, start it in
  two taps forever after."* + **＋ New template.** (Not "No data.")
- **Empty (no programs):** `MeridianMark:seed` + *"A program strings your templates
  into a plan across the week."* + **＋ New program.**
- **Offline:** full create/edit locally; `SyncStatusPill` per row; never blocked.
- **Template used by a program, on delete:** warn it's referenced (*"Push A is in your
  PPL program. Delete it there too?"*) — don't silently orphan a program slot.

---

## CORE-15 — Workout history, session detail, PRs & progression analytics

### The Lift Log (history timeline) — Lift tab, `Log` segment
Mirrors the Activity Log pattern (`screens-phase-1.md §CORE-02`) but for strength — a
**vertical timeline of sessions, grouped by week**, a personal training log (not a
social feed): no avatars, no authors, no per-row map. `WeekHeader`s carry the week's
**aggregate volume + session count** in the metric face — the "training adds up"
thesis, strength edition.
- **`WorkoutRow`:** title + relative date/time; a compact `MetricBar` (Volume · Sets ·
  Duration); a **`LiftStack:static` micro** (the session's column shape — the vertical
  cyan counterpart to `ActivityRow`'s horizontal ember `MeridianTrace:static`); a
  `PrBadge` when earned; a `SyncStatusPill` when not yet synced. Tapping opens detail.
- **Pagination:** cursor-based on `(occurred_at, id)` (§9.6), never offset; "That's
  the start of your training log." at the true end.

### Session detail (`app/(app)/workout/[id].tsx`)
Top → bottom:
1. **`LiftStack:static` (large hero)** — the session's full column, segments grouped
   and tinted per exercise, PR segments flared ember past their previous-best ticks.
   This is the detail screen's data-viz in the app's own axis language.
2. **Title + date/time** (`type.displayMd` title, `type.label` date · template name
   snapshot if logged from one).
3. **Summary `MetricBar`** — Volume · Sets · Duration · Load (`load_score`, only if
   RPE present).
4. **Per-exercise breakdown** — one section per exercise (`exercise_name_snapshot`),
   its `SetRow`s read-only (weight × reps, `SetTypeTag`, est-1RM per qualifying set),
   the **best working set** subtly marked (a cyan tint), and any `PrCallout` for that
   exercise inline. Warmups de-emphasized.
5. **Muscles worked** — a small `MuscleTag` row derived from `primary_muscle_snapshot`
   (the frozen label, §3), with a link to the muscle-volume view.
6. **Actions:** **Edit** (opens the logging screen on this session; edits route
   through `save_workout_session_v1`, re-running PR detection + volume recompute, §7)
   and **Delete** (soft-delete on the spine `timeline_events.deleted_at`, §8; the RPC
   never writes this — it's a direct owner update, reconciled for PR correctness by
   the delete-toggle trigger, `RPC §2.6`). Destructive confirm names the consequence,
   `feedback.dangerSolid`.

### Strength Records — Lift tab, `Records` segment
The current best per exercise per metric (`strength_records`), **grouped by
exercise**:
- One collapsible group per exercise the user has records in, header = exercise name +
  a `MeridianMark:glyph`.
- Inside, one **`RecordRow`** per applicable `metric` (from exercise metadata §4.1):
  **Heaviest** (`heaviest_weight`), **Est. 1RM** (`estimated_1rm`), **Best set volume**
  (`best_set_volume`) for weighted movements; **Max reps** (`max_reps`) for bodyweight/
  rep movements. Each row is tappable to the session that holds it
  (`timeline_event_id`), value in the metric face (`unit_snapshot`), with the thin
  **vertical** cyan record-bar behind it.
- **Reserved-but-hidden metrics** (`rep_pr_at_weight`, `longest_hold`, §4.1 / `RPC §6`)
  are **not rendered** in Phase 2 — the enum reserves them; the UI simply omits metrics
  with no data, so nothing looks half-built.

### Progression analytics (CORE-15 — the deliberate data-viz)
- **Per-exercise over time** (`get_exercise_progression_v1`): the **`ProgressionChart`**
  (§A) — one **vertical column per session** (height ∝ est-1RM or session-volume-for-
  this-exercise, a metric-face toggle between the two), the current-PR column flared
  ember, a faint rising trend baseline. **Gaps are honest** — a missed week is spacing
  on the time axis, never an interpolated line pretending continuity. Reachable from
  session detail (per exercise) and from a Records row.
- **Volume per muscle** (`get_muscle_volume_v1`): the **counterpart** treatment — a
  **horizontal** bar breakdown (muscles ranked by volume, cyan bars, top muscle
  emphasized), because a *distribution* is horizontal where a *time series* is the
  vertical Lift column. This deliberate split (time = vertical columns / distribution
  = horizontal bars) keeps both readable and both on-brand. Uses the frozen
  `primary_muscle_snapshot` (§3) so a later re-categorization never shifts a past
  period's breakdown.

### States (history / detail / records / analytics)
- **Loading:** skeleton `WorkoutRow`s / skeleton bars — never a spinner on blank.
- **Empty (no workouts):** `MeridianMark:seed` + `type.title` **"Your first set starts
  the log."** + *"Log a workout and it lands here — every session adds to one training
  history."* + **Start a workout** (launches CORE-12).
- **Empty (no records):** `MeridianMark:seed` + *"Records show up as you lift. Your
  first working set of any movement sets the bar."* — no fake/zero records.
- **Empty (progression, one session):** the single column + *"One session in. The
  shape shows up as you keep logging."*
- **Error (load failed / offline cold start):** `InlineBanner` (`feedback.warningTint`):
  *"Couldn't load your history — you may be offline. Anything saved on this device is
  still here."* Never a full-screen wall if local data exists.

---

## CORE-16 — Progress: bodyweight, measurements, progress photos (`app/(app)/body.tsx`)

Lift tab → **Body**. Three sensitive categories, two consent gates: bodyweight +
measurements are **`health`-gated**; progress photos are **`body_image`-gated** (the
new dedicated category, §6/§12.5). All three are forced-private spine events, never
shareable (§1.9). Offline-first with `SyncStatusPill` throughout.

### Body landing
- **Current weight** — the latest `bodyweight_logs` value, big in the metric face
  (`type.metricXl`), unit from `unit_weight_snapshot`; a small bodyweight trend line
  beneath. **Log weight** CTA.
- **Measurements** — latest value per site (`body_measurement_values`), metric face;
  **Log measurements** CTA.
- **Progress photos** — the gated section (below).

### Bodyweight logging (health-gated)
- A sheet: **Weight** (Field, metric face, unit from `profiles.unit_weight`), optional
  **Body fat %**, **Date** (default today), optional **Notes**.
- **Consent:** first log without an active `health` consent → the **E1 health
  `ConsentSheet`** (priming precedes any ask, P0 §E). Declining leaves the feature with
  a graceful inline explanation + one-tap re-ask — never a dead screen.
- Offline-first; confirmation **"Weight logged."** ("Current weight" is a query over
  the latest log, not a mutable field, §1.9.)

### Body measurements (health-gated)
- A sheet capturing **one occasion, multiple sites** (waist/chest/hips/thigh/biceps/…,
  §1.9) — each a value + unit (`cm`/`in`, or `%` for body-fat). Add only the sites you
  measured; a weigh-in isn't required to fill every field.
- Same `health` consent gate + graceful decline; confirmation **"Measurements logged."**

### Progress photos (`body_image`-gated — the sensitive flow)
This is the module's most sensitive data (often near-nude) and gets the strictest,
most deliberate treatment (health-data-compliance).

**The `body_image` consent priming sheet (new — follows the P0 §E pattern exactly).**
A per-category, at-point-of-use, states-what-we-won't-do priming sheet — the fourth
`ConsentSheet` category, but styled deliberately **without a bright brand accent**:
its icon sits in `text.primary` on `bg.inset` with a **lock glyph** — because this is
a *protection*, not a feature to sell, and privacy reads as restraint. (The three
Phase 0 categories are feature-consents with feature colors; this one is not.) Copy,
in the `consentContent.ts` shape so it slots straight into `CONSENT_CONTENT`:

```
body_image: {
  title: 'Save progress photos?',
  purpose:
    'Progress photos let you see how your body changes over time — front, side, and
     back, compared across dates. They live only in your account.',
  wontDo:
    'Progress photos are the most private thing in MileLift. They’re stored
     encrypted, only you can open them, they’re never in any feed and can never be
     shared or made public — that’s built into the app, not a setting you have to
     find. We never use them to train anything or send them to anyone.',
  allowLabel: 'Save progress photos',
  declineLabel: 'Not now',
  footnote:
    'This is separate from health data — you can keep photos off while everything else
     stays on, or turn photos off later on their own, in Settings › Permissions &
     data. Turning it off stops new photos; what you’ve saved stays until you
     delete it.',
  accentColor: /* neutral: text.primary on bg.inset + lock glyph, NOT a brand accent */,
}
```

- **Camera vs. library:** taking a photo needs the OS **camera** permission too — so
  "Take photo" runs the Phase 0 **E3 camera `ConsentSheet`** at that sub-step; "Choose
  from library" skips it. The `body_image` sheet is the primary gate (it authorizes
  *storing the body image*); camera is only the capture mechanism. Don't stack both
  sheets up front — `body_image` first (it's the data ask), camera only if the user
  chooses the camera.
- **Capture flow:** pick **pose** (`front`/`side`/`back`/`other`, §1.9) → take or
  choose → the bytes upload to the owner-only `progress-photos` Storage bucket first,
  **then** the metadata row is written (upload-then-metadata ordering, §5/§10 — never
  "saved" on a partial upload). Offline: the photo is retained locally and uploads
  idempotently on reconnect (deterministic path); `SyncStatusPill` reflects state.
- **Privacy in-app (a real design decision, not a toggle buried later):**
  - Gallery thumbnails are **`PhotoTile`s — blurred/locked by default**, tap to reveal
    (a glance at your phone in a gym never exposes body imagery). A per-session
    "Always reveal on this device" opt-out exists for private use.
  - A persistent **lock affordance + "Only you can see these"** on the photos surface.
  - Served via **short-expiry signed URLs**, never public (§6, §8).
- **Compare view** (`app/(app)/body/photos.tsx`): same-pose-over-time, two dates side
  by side (the "front pose over time" payoff, §1.9). Dates in the metric face.
- **Delete:** soft-delete + 30-day grace (§7/§12.6); the account-deletion job also
  purges the Storage objects (§7). Confirm names the grace window.

### States (all three)
- **Consent declined:** each feature degrades to a specific inline explanation + a
  one-tap re-ask (never a crash/dead screen) — e.g. photos declined → *"Progress
  photos are off. Turn them on to start a private photo timeline. Turn on."*
- **OS camera denied (after body_image allowed):** one-time `InlineBanner` routing to
  OS Settings — *"Camera is off in your phone's Settings. Add a photo from your library
  instead, or Open Settings."* Don't loop the in-app prompt against an OS block (P0 §E).
- **`body_image` revoked later (Profile › Permissions & data):** new photo writes stop
  immediately; existing photos untouched until an explicit delete; `health` logging
  keeps working (independent withdrawal, §6). Non-crashing.
- **Loading / empty / offline / upload-failed:** skeletons; `MeridianMark:seed` empty
  states in voice; offline retains locally and syncs on reconnect; a failed upload
  shows "Sync failed · retry" and keeps the local photo (§10).

**Profile addition:** the **Permissions & data** section (P0 §F.5) gains a fourth row
— **Progress photos** (`body_image`) — with the same On / Off / Off-in-Settings chip +
revocation-confirm pattern as the existing three. (Extend the existing section; don't
build a new one.)

---

## CORE-17 — Offline sync-status treatment (the load-bearing thread)

Offline-first is "the hardest item in this phase" (§9) and the trust it buys is a
stated product goal. The UI's job is to make offline-safety **legible** — the user
should *trust*, from what they see, that a workout logged in a gym basement is safe.

- **`SyncStatusPill` — one new state added: `local`.** Phase 0 defined
  Saved / Syncing / Sync failed. Phase 2 adds **`local` — "Saved on device"** — the
  state of an in-progress or just-finished record that is **durable in local SQLite but
  not yet a synced server row** (§9.1/§9.3). It reads as reassurance, not alarm: a
  neutral treatment (`text.secondary` + a small device glyph), **not** growth-green
  (nothing is confirmed server-side yet) and **not** danger. State machine:
  `local` (in-progress / finished offline) → `pending` ("Saved · will sync") →
  `syncing` ("Syncing…", cyan) → `synced` ("Synced", growth + check) /
  `failed` ("Sync failed · retry", danger + retry). Every state carries a text label
  (non-color signal), never color alone.
- **Where it appears:** the active logging top bar (`local`), every `WorkoutRow` and
  session-detail (until synced), custom-exercise rows, template/program rows, and every
  biometric/photo row. Not on read-only library content (it's a server mirror, not the
  user's unsynced writes).
- **Save is never blocked on network.** Finish always saves locally and returns the
  user to their log; the RPC call is a background reconcile. This is the copy-level
  promise too — the priming/empty copy says the log is safe offline, and the pill
  proves it live.
- **Idempotency is invisible but designed:** two grains (session `id` + per-set `id`),
  every write `ON CONFLICT (id) DO UPDATE`, removals as explicit `deleted_at` tombstones
  (never omission) — so the gate test (*full workout in airplane mode → reconnect →
  exactly one copy*) holds no matter how the flaky sync retries (§9.2, `RPC §2.1`). The
  optimistic on-device PR badge at completion (§CORE-12) is **reconciled** against the
  RPC's authoritative `achievements` array on sync — if the server disagrees (e.g. a
  second device already logged a heavier set), the badge is quietly corrected, never a
  second celebration and never a badge that contradicts the server (mirrors the Phase 1
  optimistic-PR seam, `screens-phase-1.md §CORE-04` — flagged for `mobile-builder`/
  `backend-builder` alignment).

---

## Handoff checklist for `mobile-builder`

- **Tokens only.** Every color/space/type/motion is a named `theme.ts` token. The only
  new token this phase is `color.restTimer` (a semantic alias group, no new hue —
  `tokens.md §2.2`); use it only in the `RestTimer`. The `LiftStack` uses
  `accent.data` (cyan, the Lift-axis hue) and `accent.primary` (ember) for PR flares —
  no new color, exactly as `MeridianTrace` reused `accent.primary`. No literals.
- **Numeric face everywhere numbers live** — reps, weight, est-1RM, volume, load,
  rest countdown, RPE, records, week aggregates, measurements, bodyweight — all use
  the metric face with `fontVariation.metric` (tabular). It is the app's content, not
  optional.
- **`LiftStack`** is one component with `live` / `static` / `empty` variants; segments
  = completed **working** sets (warmups/failed/incomplete never stack); PR segment
  flares ember past the previous-best tick; reduced motion drops the rise easing but
  still updates segments/data. Reuse `MeridianMark` for FAB glyph + empty-state seeds
  — draw no new glyphs.
- **`RestTimer`** is first-class: auto-start on rest-target set completion, ±15s /
  Skip, gold final-10s + growth done, a **background local notification at zero**,
  fully offline, `rest_seconds_actual` written to the set. Non-color signal at every
  state.
- **Metadata-driven UI:** `SetRow` columns, PR metrics, and library adaptation are all
  functions of exercise metadata (`is_weighted` / `is_bodyweight` / `is_time_based` /
  `is_distance_based`, `muscle_group`, `equipment`) — no per-exercise hardcoding.
- **Save/edit/delete map to the RPC contract exactly:** finish/edit →
  `save_workout_session_v1` (session `id` + per-set `id` idempotency, upsert-present
  never delete-omitted, `estimated_1rm_kg` never client-sent, snapshots client-supplied
  at log time — `RPC §2.1–2.3`); a set removed → explicit `deleted_at` in the payload;
  a whole session deleted → direct owner `UPDATE` on `timeline_events.deleted_at`
  (`RPC §6`); a set's exercise reference is **immutable after first save** (tombstone +
  recreate to change it, `RPC §2.3`). **Sync push must be strictly sequential** (single
  in-flight guard, never `Promise.all`) — a hard requirement to avoid the accepted
  cross-device PR-duplication race (`RPC §2.6`).
- **Consent at point of use:** bodyweight/measurements reuse the **E1 health**
  `ConsentSheet`; progress photos gate on the **new `body_image` category** (its
  priming copy above, neutral/lock styling, precedes camera which reuses **E3**);
  writes go through the live `user_consents` mechanism; graceful decline/OS-denied/
  revoked states are **requirements**, not polish (§6). Add the `body_image` row to
  Profile › Permissions & data.
- **Offline-first is load-bearing:** logging works fully offline; finish saves to local
  SQLite first and syncs idempotently; the `SyncStatusPill` (with the new `local`
  state) is visible on every unsynced write; PR badge is optimistic-then-reconciled;
  photo upload is upload-then-metadata and never reports "saved" on partial failure.
  Never block Save on network.
- **Attribution ships in-app** (the Exercise data credits screen) — a §6/§12.1 gate
  item, not a doc-only line.
- **Accessibility floor (not a tradeoff):** every control ≥ `touchTarget.min`
  (complete-toggle, ±15s/Skip, add-set sized generously for mid-set use); reorder has a
  non-drag accessible path (Move up/down with announcements); RPE and rest are proper
  adjustable roles; set-type / sync / PR / rest state each carry a non-color signal
  (glyph or label), never color alone; reduced motion honored on the LiftStack rise,
  PR flare, and rest pulse; contrast per `tokens.md` (danger fills use
  `feedback.dangerSolid`, `text.tertiary` never normal body text).

---

## Decisions (settled 2026-07-21) and implementation-coordination notes

The design calls below were the ones worth a second look or that touch product voice;
all seven were **decided by the person on 2026-07-21** and are settled — recorded here
(mirroring the architecture docs' §12 pattern) so `design-reviewer` and future work can
tell a deliberate choice from a default. The final two are not person-level decisions —
they are coordination notes flagged for `mobile-builder`.

1. **`LiftStack` prominence — APPROVED as designed.** The rising vertical column (the
   deliberate mirror of Phase 1's `MeridianTrace`) is **slim/peripheral during active
   logging** (the input grid stays primary — legibility mid-set ranks highest, per the
   standards) and **hero on the Save sheet + session detail**. This trade is confirmed.
2. **Tab naming — kept as-is: "Activity" + "Lift."** No rename of the existing Activity
   tab for symmetry. The mild Mile/Lift asymmetry is accepted; "Lift" stays the brand
   word for the new tab (and continues to house Body/progress for Phase 2, per §5).
3. **Progress-photo privacy — blurred by default, tap to reveal**, with the per-device
   "always reveal" opt-out, exactly as proposed (§CORE-16). Confirmed as the posture.
4. **`body_image` consent styling — APPROVED as designed.** Neutral, lock-glyph
   styling, deliberately distinct from the three colored Phase 0 feature-consents,
   because it's a protection rather than a feature. The copy above is approved to land
   in `consentContent.ts`.
5. **Body/progress under the Lift tab — APPROVED for Phase 2.** Bodyweight,
   measurements, and photos live under Lift now; they *may* migrate to a unified
   Progress area later when the Home dashboard is built — **not now**.
6. **Session RPE stays optional** — not gated on save (NULL is valid → no `load_score`,
   `RPC §2.7`). Keeping the fastest-path finish unblocked wins over forcing RPE.
7. **Program builder stays a plain schedule *list*, not a calendar** — deliberately, so
   the UI never implies an auto-advancing scheduler that doesn't exist yet (§11).

**Implementation-coordination notes for `mobile-builder` (not person-decisions):**

8. **Optimistic-then-reconciled strength PR badge** (same seam as Phase 1). The
   celebration at set-completion is computed on-device against the local
   `strength_records` cache and **reconciled** against the RPC's authoritative
   `achievements` array on sync — a server disagreement quietly corrects the badge,
   never a second celebration (§CORE-12 / §CORE-17). This requires `mobile-builder` +
   `backend-builder` to keep the two from visibly diverging; the RPC supports it but
   doesn't itself state the celebration is optimistic (`RPC §2.6`). Coordinate on this
   seam during the build.
9. **"Video coming soon" only — no video player state exists in Phase 2** (video is out
   of scope, §2/§13). When the content track backfills `exercise_media` video rows, the
   exercise-detail screen will need a real player spec — a future design task, flagged
   here so it isn't assumed already done.
