# MileLift — Phase 1 Screen Specs (Module A · Activity & Movement Tracking)

Status: **v1, implementable.** Consumer: `mobile-builder` (build directly against
this; do not re-derive decisions). This **extends** the Phase 0 system — every
value is a named token from `docs/design/theme.ts`, every screen inherits the
Phase 0 component vocabulary (`screens-phase-0.md §A`) and the precise-plainspoken-
coach voice (`tokens.md §1`). If you want a literal, that's a missing token — add
it to `theme.ts` first.

Covers CORE-01 … CORE-05 UI, designed against `docs/architecture/phase-1-module-a.md`
(the confirmed data model; §-refs below are to that doc unless prefixed `P0`).

Scope guardrail: **Module A activity UI only** — recording, activity detail +
history/timeline, PR/achievement surfaces, the own-activity log, and the Health
Connect connect surface. **Not** in scope: a redesigned Home dashboard, nutrition/
strength logging (Modules B/C), a cross-user social feed / live kudos loop (Phase 4,
§12.1), cross-user route sharing (Phase 2, §2.3), best-effort sub-distance PRs
(§12.4), recovery-sample UI (§3.5). Where those are deferred, the surface here is
built so it does not look broken by their absence.

---

## 0. Why this phase looks the way it does (the one idea)

Phase 0 established the **Mile ↔ Lift duality** and the **Meridian** signature (a
warm horizontal Mile axis meeting a cool vertical Lift axis at an origin). Module A
is the **Mile** made real — GPS, distance, pace, routes. So Phase 1 is where the
**horizontal ember axis becomes a working instrument**, not just a logo motif:

> **A recorded activity literally draws the Mile axis.** The Meridian's horizontal
> stroke, which onboarding taught the user to associate with distance-over-time, is
> the same line that grows across the recording screen as they move, that plots
> their splits and elevation, and that — when they beat a record — extends past its
> previous mark. One motif, carried from the logo to the live screen to the PR
> moment. No competitor's recording screen is built from this, because no
> competitor's brand is the hybrid axis.

This is the answer to the category's two biggest recording clichés, chosen on
purpose, not defaulted into:
- **Not a circular progress ring** (Nike/Apple) — the hero is the horizontal
  **MeridianTrace**, the app's own axis, not the most-copied ring in the category.
- **Not a map-as-hero** during recording (Strava) — mid-run you glance at numbers,
  not a map you can't read at a stride; the map is one tap away, not the default.

---

## A. New component vocabulary (Phase 1 adds these; compose, don't re-style)

Defined once here; screens below reference them. All inherit Phase 0 §A patterns.

- **MetricStat** — one metric rendered in the **metric face** (`fontVariation.metric`,
  tabular): a `value`, a small `unit`, and a `label` (`type.overline`, uppercase,
  `text.tertiary`). Size variants: `hero` (`type.metricXl`, the mid-run glance),
  `primary` (`type.metricLg`), `inline` (`type.metricMd`). Never boxed on its own.
- **MetricBar** — a **horizontal row** of 2–3 `MetricStat`s separated by hairline
  (`border.subtle`) vertical dividers, no cards, no icons. This is the deliberate
  anti-pattern to the icon-number-label grid the standards warn against, and it
  reinforces horizontality (the Mile axis).
- **MeridianTrace** — the signature applied to activity. A horizontal ember
  (`accent.primary`) stroke anchored at a left origin dot (`text.primary`), the Mile
  axis being drawn.
  - `live` variant (recording): extends left→right in real time; drops a **split
    notch** (`border.strong`) at each km/mi with that split's pace stamped in
    `type.metricSm`; its baseline undulates to the elevation profile so far when
    elevation data exists. Grows continuously — it is **not** a fill-to-100% bar
    (a free run has no target); it is a living axis.
  - `static` variant (detail / history row): renders the finished activity's
    pace-or-elevation profile as a compact horizontal sparkline in ember.
  - `empty`/manual: a flat faint baseline + origin only (no data to plot).
  - Reduced motion: `live` still updates its endpoint (that's data, not decoration)
    but without the draw easing; `static` renders complete.
- **RouteMap** — a MapView with the **dark desaturated graphite tile style** (custom
  style JSON, not the platform default map), drawing `simplified_path` as
  `map.route` with a `map.routeCasing` underlay, a `map.startMarker` dot, and a
  `map.finishMarker` Meridian-origin glyph, camera fit to `bounds`. Owner-only data
  (§8) — only ever shown for the viewer's **own** activity in Phase 1. Has explicit
  no-route (manual) and location-declined fallbacks (below).
- **GpsSignal** — a small telemetry chip in `accent.data` (cyan = tracking/accuracy,
  the whole reason cyan exists) showing `Acquiring…` / `Strong` / `Weak` / `Lost`,
  driven by GPS `accuracy`. Color is never the only signal — it carries a text label
  and a 3-bar glyph.
- **RecordControl** — the record/pause/resume/finish cluster (§CORE-01).
- **TypePicker** — activity-type selector over the 19-seed `activity_types` catalog,
  respecting `supports_gps` / `is_distance_based` / `tracks_elevation` metadata.
- **ActivityRow** — one activity in the timeline: type + title, relative date, a
  compact `MetricBar`, a `MeridianTrace:static` micro-thumbnail, and a `PrBadge` if
  it earned one.
- **WeekHeader** — timeline week grouping with the week's aggregate distance +
  activity count in the metric face (the "your training adds up" thesis).
- **PrBadge** / **PrCallout** — the record indicator on a row / the save-time "New
  best" flare (§CORE-04).
- **RecordRow** — one cumulative PR on the Records screen.

---

## B. Navigation & app-shell changes (`app/(app)/_layout.tsx`)

Phase 0 shipped a two-tab shell (Home placeholder · Profile) that deliberately used
text-only tab labels (no invented icon set). Phase 1 keeps that discipline:

- **Tabs become: Home · Activity · Profile** — three text labels, no new icon set.
  Home stays the Phase 0 placeholder (a real dashboard is out of scope for this
  phase; noted, not faked).
- **Activity tab** (`app/(app)/activity.tsx`): a segmented header **Log | Records**
  (`radius.pill` SegmentedControl, reused from Phase 0). `Log` is the timeline
  (§CORE-02/05); `Records` is the PR list (§CORE-04).
- **Start recording** launches as a **FAB**, bottom-right of the Activity Log,
  thumb-reachable one-handed: an `accent.primary` circle, `touchTarget.comfortable`
  min (spec 64pt), carrying the **Meridian origin glyph** as its mark (a defined
  glyph, not a new icon — consistent with the no-icon-set decision). Label for a11y:
  "Start recording."
- **Recording** is a **full-screen modal route** (`app/(app)/record.tsx`, presented
  modally, keep-awake), not a tab — it's a single immersive task, not a place you
  browse to. It owns the status bar and blocks the tab bar while active.
- **Activity detail** is a pushed route `app/(app)/activity/[id].tsx`.

Rationale (flagged, §Judgment calls): a raised center record button in the tab bar
is the ergonomic ideal but would force an icon set this project has deliberately
deferred; the FAB gets ~the same reach without that. Revisit when an icon system
is designed.

---

## CORE-01 — Recording (`app/(app)/record.tsx`) — the core interaction

The most-used, most-glanced, often one-handed / mid-stride / sweaty-hands screen in
the whole app. **Legibility and the numeric face rank above every decorative
choice here** (the standards' explicit instruction for active logging). It has four
states: **Ready → Recording → Paused → Finishing/Save.**

### Layout (Recording state, top → bottom)
1. **Top bar:** the selected activity type as a tappable chip (opens `TypePicker`,
   only editable in Ready state — locked once recording starts), and a `GpsSignal`
   chip (cyan). A small `SyncStatusPill` is **absent** here — recording is local-only
   until finish (§9); sync status belongs to the saved activity, not the live one.
2. **Hero metric:** one `MetricStat:hero` (`type.metricXl`) — **Duration by
   default** (see decision below), value in `text.primary`, label `text.tertiary`.
   Tapping the hero swaps which metric occupies it (Duration ⇄ Distance ⇄ Pace) —
   the well-loved "promote the big number" pattern. The choice is remembered
   locally.
3. **MeridianTrace:live** spans the full content width directly under the hero — the
   Mile axis the run is writing, with split notches + per-split pace. This is the
   screen's signature and its at-a-glance history-so-far.
4. **MetricBar** (the two metrics not currently in the hero, plus Elevation when the
   type `tracks_elevation` and data exists): e.g. `Distance · Pace · Elev` in the
   metric face, hairline-divided, no boxes.
5. **RecordControl** pinned to the bottom safe area, in easy thumb reach.
6. A **Map peek** toggle (`accent.data` text button, "Show map") flips the hero/trace
   area to a live `RouteMap` for users who want it; default is metrics-first. Toggle
   is disabled if location isn't granted (no route to show).

### Metric semantics (decided — the data model distinguishes these, so the UI must)
- **Hero default = Duration.** It is always available (it's the spine's
  `duration_seconds` currency), works with **no** location/GPS at all, and is the
  one metric a manual or route-declined activity still has. Distance/Pace require
  GPS and are promotable but not the default. *(Judgment call — flagged.)*
- The live clock shows **moving time** (`moving_time_seconds`) — it **stops while
  paused** — because that matches what a runner means by "my time." A secondary
  `type.metricSm` "Elapsed" (the spine's `duration_seconds`, keeps counting through
  pauses) sits under the hero so both model fields are honest and visible. Phase 1
  pause is **manual only**; auto-pause is not specified here (flagged for
  `mobile-builder` as an optional later enhancement, not a Phase 1 requirement).
- **Pace shown live is *current* pace** (a rolling on-device derivation from recent
  GPS) and is **not persisted** — only whole-activity `average_speed_mps` is stored,
  from which the detail screen derives **average** pace. Label the live one "Pace"
  and the detail one "Avg pace" so they're not conflated. *(Flagged.)*
- Units come from `profiles.unit_distance` and are snapshotted onto the activity at
  finish (`unit_distance_snapshot`) — the value shown mid-run is the value saved.

### RecordControl behavior (safeguards are the point)
- **Ready:** one large `PrimaryButton` — **"Start"** — full-width,
  `touchTarget.comfortable`. Big target on purpose (gloved/cold-hands start).
- **Recording:** the primary control becomes **"Pause"** (still ember, large). There
  is deliberately **no Finish button while actively recording** — you cannot end a
  run with one stray tap mid-stride. Finish is reachable only from Paused.
- **Paused:** two equal controls appear — **"Resume"** (`PrimaryButton`, ember) and
  **"Finish"** (`SecondaryButton`). Finish opens the Save sheet. The `MeridianTrace`
  and clock hold visibly still while paused, so "paused" is unmistakable.
- All control transitions animate at `duration.fast`; the trace endpoint tracks data
  continuously (not gated on reduced motion — it's information).

### Location consent at point of use (reuse Phase 0 E2 — do NOT reinvent)
Trigger: the user taps **Start** on a `supports_gps` type while `location` consent is
not active. Show the **existing** `ConsentSheet` with `category="location"` (the E2
priming sheet, copy already in `consentContent.ts`) — *before* the OS prompt (P0 §E
rule 5). Outcomes:
- **Allow** → OS When-In-Use prompt → on grant, write the `user_consents` location
  row, then begin recording. Toast mirrors the verb: "Location on."
- **Not now** / **OS-denied** → recording **still starts** (graceful degradation,
  §6/§10). The hero falls back to Duration, Distance/Pace are hidden (no GPS), the
  Map peek is disabled, and a single `InlineBanner` (`feedback.warningTint`) states
  the E2-declined copy verbatim: *"No route without location. Recording time and
  heart rate instead. **Turn on location.**"* Tapping re-runs the priming sheet.
  This produces a valid **manual-style** activity (`has_gps_route = false`,
  `distance_m` NULL) — never a crash, never a dead screen.
- **Revoked mid-recording** (OS setting changed while running): stop consuming
  location immediately (§6 — no stale-authorized reuse), keep the clock running,
  surface the same banner. The route captured up to that point is still valid.

### TypePicker (the 19-seed `activity_types` catalog)
- **Quick row:** the highest-`sort_order` common types as `radius.pill` chips
  (Run · Ride · Walk · Hike…), selected chip = `accent.primaryTint` fill +
  `accent.primary` text. Tapping a chip sets the type.
- **"All types"** opens a bottom sheet (`radius.xl`, `bg.raised`) listing the full
  catalog **grouped by `category`** (Foot · Cycle · Water · Winter · Gym cardio ·
  Other), each row = `activity_types.display_name`. Selecting closes the sheet.
- The picker reads catalog **metadata** and adapts the whole screen: a type with
  `supports_gps = false` (e.g. a treadmill/gym type) hides the GPS/Map affordances
  and never prompts for location; `is_distance_based = false` (e.g. yoga) hides
  Distance/Pace and shows Duration-only; `tracks_elevation = false` hides Elevation.
  The screen is a function of the type's metadata, not hardcoded per type.
- Editable only in **Ready**; locked once recording begins (changing type mid-run
  would invalidate the captured data). Locked chip shows a small lock affordance +
  a11y "Activity type locked while recording."

### The Save sheet (Finish flow)
Opens from Paused → Finish. A bottom sheet (`radius.xl`, `bg.raised`):
- **Summary MetricBar** (final, from the just-computed summary): Distance · Moving
  time · Avg pace · Elevation gain (only the ones that apply to the type).
- **MeridianTrace:static** of the whole route's profile.
- **Title** Field, pre-filled with a sensible client default (e.g. "Morning Run",
  from time-of-day + type — `activity_details.title`). Editable.
- Optional **Description** Field (one line, expandable).
- **PrCallout** if this activity set any records — see §CORE-04.
- Primary: **"Save activity."** Confirmation mirrors: **"Activity saved."**
- Secondary: **"Discard"** — destructive, `feedback.dangerSolid` confirming button,
  names the consequence: *"Discard this recording? The route and time are deleted
  and can't be recovered."* No accidental discard.

### States
- **Ready (idle):** hero shows `0:00`, trace is origin-only, `GpsSignal` = "Acquiring…"
  until the first good fix (cyan, pulsing under normal motion; static under reduced
  motion). "Start" is enabled even before a fix (the clock can start; the route
  begins when GPS locks) — but show a one-line `text.tertiary` hint under Start:
  "Getting a GPS fix — you can start now, the route begins once it locks."
- **Weak / lost signal (mid-run):** `GpsSignal` → "Weak"/"Lost" (still cyan, plus a
  warning-gold dot); an `InlineBanner` (`feedback.warningTint`) only on sustained
  loss: "GPS signal is weak — distance may be off until it recovers." Never stop the
  clock for this; degrade honestly.
- **Backgrounded / app killed → recovery:** an in-progress recording is layer-2
  local state (`route_points_local`, §9), so on relaunch offer a resume prompt
  (bottom sheet): "You have a recording in progress — **Resume** or **Discard**?"
  Resuming restores the trace, clock, and captured route. This is a first-class
  unhappy path (`production-standards`), not optional.
- **Finishing while offline:** the activity **saves locally immediately** (SQLite is
  the source of truth, §9) and appears in the Log with a `SyncStatusPill` "Saved ·
  will sync." The raw-track upload + `save_activity_v1` RPC run on reconnect,
  idempotently (§2.1). The user is **never** blocked on network to finish a run.
- **Save error (on later sync):** the pill shows "Sync failed · retry"; the activity
  and its route are preserved locally, never dropped. Tap to retry.
- **Success:** sheet dismisses to the activity detail (or back to Log), the new row
  present at top.

### Motion
- Trace draws its endpoint continuously (data). Split notches drop with a
  `duration.fast` settle. The hero-metric swap is a `duration.base` crossfade.
- Keep-awake while recording; dim to a low-power glance mode is a nice-to-have,
  flagged, not required for Phase 1.
- Reduced motion: no pulsing GPS chip, no draw easing; values still update.

---

## CORE-02 — Activity detail + history

### The history / timeline = the Activity Log (also CORE-05)

This surface is CORE-02's list **and** CORE-05's own-activity "feed" — the same
screen, because in Phase 1 there is no cross-user feed (§12.1). It is deliberately a
**personal training log**, visually distinct from a future social feed:

- **It is a vertical timeline of horizontal activities, grouped by week** — not a
  card feed of discrete social posts. `WeekHeader`s carry the week's **aggregate**
  (total distance + activity count, metric face) because the product thesis is that
  *training adds up into one history* — a social feed shows moments, a training log
  shows accumulation. This framing is the anti-social-feed decision.
- **No avatars, no author name, no map-thumbnail-per-row, no kudos hand.** A
  map thumbnail on every row is both the Strava-feed tell and — in aggregate — a
  pile of home-revealing route images; instead each `ActivityRow` carries a
  **`MeridianTrace:static` micro-thumbnail** (the pace/elevation profile in ember),
  which is lighter, scannable, and unmistakably MileLift. The full map lives on the
  detail screen.

**ActivityRow contents:** activity-type name + `title`; relative date/time
(`Today · 7:04`, `Tue`, `Mar 3`); a compact `MetricBar` (Distance · Moving time ·
Avg pace — or Duration only for non-distance types); the `MeridianTrace:static`
micro; a `PrBadge` (§CORE-04) when the row's activity earned achievements; and a
`SyncStatusPill` when not yet synced. Manual/no-GPS activities render with a **flat
faint trace + a small "Manual" tag** (`type.overline`, `text.tertiary`) in place of
the profile — the visible "displays differently" answer. Tapping opens detail.

**Wearable-imported rows** show a small `accent.data` "From watch" tag
(`type.overline`) — provenance from `wearable_links`, so an imported run reads as
device-sourced without a different layout.

**Kudos on the timeline — deliberately not shown per row (Judgment call).** The task
allows a forward-compatible kudos count even at 0, but rendering "0" on every row of
a private log where no one can give kudos yet would read as broken and imply an
absent social audience. Decision: kudos is a **quiet, display-only count on the
detail screen** (below), not on Log rows. It is a placeholder that doesn't look
like a placeholder. Flagged for product judgment.

**Timeline states:**
- **Loading:** 3–4 `SkeletonBlock` rows under a skeleton `WeekHeader` (reuse Phase 0
  skeleton), not a spinner on blank.
- **Empty (no activities ever):** `MeridianMark:seed` (origin, faint axes — the
  established first-run visual) + headline `type.title` **"Your log starts with one
  mile."** + body `type.body` `text.secondary` *"Record a run, ride, walk, or hike
  and it lands here — every one adds to a single training history."* + a
  `PrimaryButton` **"Start recording"** (launches CORE-01). Not a generic "No data."
- **Error (initial load failed, e.g. cold start offline with empty cache):**
  `InlineBanner` (`feedback.warningTint`): "Couldn't load your history — you may be
  offline. Anything saved on this device is still here." Never a full-screen error
  wall if local data exists.
- **Pagination:** cursor-based on `(occurred_at, id)` (§5); a subtle bottom loader
  when fetching older weeks; "That's the start of your history." at the true end.

### Activity detail (`app/(app)/activity/[id].tsx`)

Top → bottom:
1. **RouteMap** hero (only when `has_gps_route = true`) — dark graphite-styled map,
   ember `map.route` line with casing, `map.startMarker`/`map.finishMarker`, camera
   fit to `bounds`. Owner-only (§8) — always the viewer's own route in Phase 1.
   Tappable to a full-screen map. Height ~40% of the viewport, never the whole
   screen (stats matter as much as the map).
2. **Title + type + date/time** (`type.displayMd` title, `type.label` type · date).
3. **Primary MetricBar** — the summary stats, metric face, hairline-divided:
   **Distance · Moving time · Avg pace · Elevation gain.** Only the metrics that
   apply to the type (`is_distance_based`, `tracks_elevation`) appear; Elapsed time
   sits under Moving time as a `type.metricSm` secondary.
4. **MeridianTrace:static (large)** — the elevation-or-pace profile across distance,
   with split markers; a small toggle switches it between **Pace** and **Elevation**
   when both exist. This is the detail screen's data-viz, in the app's own axis
   language — not a default chart-library line.
5. **Splits table** (distance-based, GPS): per-km/mi rows with split pace (metric
   face, tabular so columns align). The fastest split gets a subtle `accent.primary`
   tint marker — a milestone as a visual callout, not just another row.
6. **Heart-rate summary** — Avg HR · Max HR (metric face), **only when present**
   (wearable-sourced, `average_hr`/`max_hr` non-null). Health-sensitive; shown on
   the owner's own detail only (§12.6 keeps it out of any shared payload — moot in
   Phase 1 since nothing is shared, but the component must never render it into a
   share/export-to-third-party path, §6).
7. **Achievements** — any `activity_achievements` this activity earned, as
   `PrCallout` rows (§CORE-04): "Farthest Run · 12.4 km."
8. **Kudos affordance (forward-compatible, display-only):** a single quiet row —
   the Meridian origin glyph + a count (`0` shown) + label "Kudos", `text.tertiary`,
   **non-interactive** in Phase 1. No hand icon, no "give kudos," no implication that
   an audience exists. It reserves the spot for Phase 4 without lying about the
   present. *(This is the one place the task's "kudos even at 0" allowance is spent.)*
9. **Actions:** Edit (title/type/description → routes through `save_activity_v1`,
   re-runs PR detection, §7) and Delete (soft-delete on the spine, §8; destructive
   confirm naming the consequence, `feedback.dangerSolid`).

**Manual activity detail (no GPS):** identical layout **minus the RouteMap** (a
`MeridianMark:seed`-tinted header block with the type instead of a map) and minus
splits. Distance (if the user entered one) and Duration still show. A `type.overline`
"Manual entry" tag. This is the concrete "manual displays differently" spec.

**Detail states:**
- **Loading:** map area = `bg.inset` block; stat rows = skeletons.
- **Map tiles fail / offline:** RouteMap shows the ember route on a plain
  `bg.inset` field (the geometry is local; tiles are the only network part) with a
  small `text.tertiary` note "Map tiles unavailable offline." The route still draws.
- **Route blob still uploading / not yet synced:** the map draws from the **local**
  simplified path (encoded polyline in local SQLite, §9) regardless of raw-track
  upload state; a `SyncStatusPill` reflects sync. Never show a blank map for an
  activity that has a local route.
- **Not found / deleted:** "This activity isn't here anymore." + back.

---

## CORE-04 — PR / achievement surfaces

Two surfaces, one language. **Personal records are celebrated through the Meridian,
not a medal.** (See `tokens.md §2.1` for why no new "celebration" color was added.)

### At save time — `PrCallout` (the moment)
`save_activity_v1` returns an `achievements` array; render it in the Save sheet
(and echo on the detail). For each achievement:
- The **Mile axis extends past a marked "previous best" tick** and the origin
  **flares** in `accent.primary` (an ember glow via shadow, not a new color) —
  literally "you went farther/faster than the line you'd drawn before."
- A `feedback.success` (growth) **"New best"** tag with the **delta** derived from
  `personal_records.previous_value`: e.g. **"Farthest Run yet — 12.4 km, +1.2 km
  over your last best."** Specific, in voice, no exclamation-and-emoji.
- Multiple PRs in one activity stack as multiple lines (Farthest · Fastest pace ·
  Most climbing), each with its metric and delta. If it's a **first-ever** activity
  of that type (no previous), copy is "First Run on record — 8.0 km." (no negative
  "+" delta, no implied comparison to zero).
- **No confetti, no medal, no trophy burst** — the anti-generic ledger (`tokens.md
  §7`) rules those out; the flare + the specific number is the reward.

**Offline PR detection (Judgment call — flagged).** The authoritative `achievements`
array comes from the **server** RPC, but a run is finished **offline** constantly.
Decision: at finish, compute PRs **optimistically on-device** against the local
`personal_records` cache (the same O(#metrics) point comparison the RPC does, §4.3 —
the local cache exists precisely for this, §9), so the celebration is **instant and
works offline**. On sync, reconcile with the RPC's authoritative array: if the
server disagrees (e.g. another device already logged a better effort), quietly
correct the badge — never a second celebratory interruption, and never a badge that
contradicts the server long-term. This optimistic-then-reconcile seam needs
`mobile-builder` + `backend-builder` alignment; the data model supports it but the
architecture doc doesn't state the celebration is optimistic.

### Records screen (Activity → **Records** segment) — the cumulative home
The "current best per type" from `personal_records`, grouped by
`activity_type_code`:
- One collapsible group per activity type the user has records in (Run, Ride,
  Walk…), header = type name + a `MeridianMark:glyph`.
- Inside, one **`RecordRow`** per `metric` that applies to the type (from
  `activity_types` metadata): **Farthest** (`longest_distance`), **Fastest pace**
  (`fastest_avg_pace`), **Longest** (`longest_duration`), **Most climbing**
  (`most_elevation_gain`, only if `tracks_elevation`). Each row: metric label
  (`type.overline`), the **value in the metric face** (`type.metricLg`, in
  `unit_snapshot`), a `text.tertiary` "· {relative date}", and the row is **tappable
  to the activity that holds it** (`personal_records.timeline_event_id`). A tiny
  ember Mile-axis bar sits behind the value as the "record bar" motif.
- **Reserved-but-hidden metrics** (`fastest_1k`/`5k`/`10k`, the deferred best-efforts
  §12.4) are **not rendered** in Phase 1 — the enum reserves them; the UI simply
  doesn't list metrics with no data, so nothing looks half-built.

**Records states:**
- **Loading:** skeleton group + rows.
- **Empty (no PRs yet):** `MeridianMark:seed` + "Records show up as you log.
  Your first activity of any type sets the bar." No fake/zero records.
- **Per-type partial:** only show metrics that have a value; a type with one activity
  legitimately shows all-its-firsts as records.

---

## CORE-05 — Own-activity timeline ("feed", scoped)

Fully covered by the **Activity Log** above — CORE-02's history and CORE-05's
own-activity feed are the same surface in Phase 1 by design (§12.1). Restating the
CORE-05-specific decisions so they're not lost:

- **It reads as a personal training log, not a placeholder social feed** — week
  aggregates, accumulation framing, no avatars/authors/kudos-hand. It does not look
  broken by the absence of other people because it was never built to imply them.
- **Forward-compatible, not misleading:** the kudos count lives (display-only, once,
  on detail), `wearable_links` provenance tags exist, and the row layout has room for
  a future author/kudos strip — so Phase 4 adds a *cross-user* feed as a **new**
  surface (follows-based) without this one having lied about being social.
- **Routes are never rendered cross-user** (§2.3) — moot here (own log only), but the
  `RouteMap` component must gate rendering on ownership so a future shared-feed reuse
  can't accidentally leak geometry before privacy zones (Phase 2). Bake the
  owner-only guard into the component, not the screen.

---

## CORE-03 — Health Connect connect surface (Android-first)

Phase 1's **minimum real surface** for `mobile-builder` to wire the Health Connect
permission/sync/write-back flow into — deliberately not elaborate. Lives in
**Profile**, as a new section under the existing Phase 0 sections (anchored by a
`MeridianMark:glyph`, matching the profile section pattern):

**Profile › "Apps & devices"**
- **Health Connect** row with a status chip:
  - *Not connected* → neutral chip "Not connected" + `PrimaryButton`-weight action
    **"Connect Health Connect."** Tapping runs the **existing E1 health `ConsentSheet`**
    (priming, precedes the OS/Health Connect permission grant, P0 §E rule 5) → the
    Health Connect permission UI → on grant, connected.
  - *Connected* → `accent.growth` chip "Connected" + a `text.secondary` last-sync
    line in the metric face: "Last synced · 7:12 AM." A **"Sync now"** TextButton.
  - *Syncing* → chip "Syncing…" (cyan), non-blocking.
  - *Error* → `feedback.warning` chip "Sync issue" + a specific one-line reason +
    "Try again" (never a raw error string).
  - *Permission revoked in Health Connect* → chip "Reconnect needed" +
    "Reconnect" — graceful, no crash (§10); existing local data is untouched.
- **Write-back toggle** (visible only when connected): *"Also write my MileLift
  activities to Health Connect"* — controls the §3.2 write-back. Sub-label states the
  §12.7 limit plainly: *"Sends the session, distance, and calories — not your route.
  Your map stays in MileLift."* Off by default (opt-in).
- **Platform gate:** on **iOS**, the row is hidden/replaced with a `text.tertiary`
  "Health Connect is Android-only. Apple Health support is coming." — the confirmed
  Android-first scope, stated honestly rather than showing a dead button.

This reuses the health consent and the Phase 0 permissions pattern wholesale — the
`ui-ux-design-standards` rule for a new screen (extend, don't reinvent). It does not
build the sync engine (that's `mobile-builder` wiring the native Health Connect
module, §3.1) — it's the surface that flow attaches to.

---

## Handoff checklist for `mobile-builder`

- **Tokens only.** Every color/space/type/motion is a named `theme.ts` token. The
  only new tokens this phase are `color.map.*` (route rendering, §2.1 tokens.md) —
  use them for the RouteMap, nothing else. No literals in components.
- **Numeric face everywhere numbers live** — every metric (duration, distance, pace,
  elevation, HR, splits, records, week aggregates) uses the metric face with
  `fontVariation.metric` (tabular). This is the app's content; it is not optional.
- **MeridianTrace** is one component with `live` / `static` / `empty` variants;
  reduced-motion updates data without draw easing. Reuse `MeridianMark` for the FAB
  glyph and empty-state seeds — do not draw new glyphs.
- **Consent:** recording reuses the E1/E2 `ConsentSheet` and writes `user_consents`
  exactly as Phase 0; priming precedes the OS prompt; request **When-In-Use**
  location and only the specific Health Connect types the sync uses (§6). Graceful
  decline/revoke states are **requirements**, not polish.
- **Offline-first is load-bearing here:** recording works fully offline; finish saves
  to local SQLite first and syncs via `save_activity_v1` idempotently (client
  `id` = idempotency key, §2.1/§9); the map draws from the **local** simplified path
  regardless of raw-track upload state; PR celebration is optimistic-then-reconciled
  (§CORE-04, flagged). Never report a finish as "synced" on partial failure (§10,
  `production-standards`).
- **RouteMap owner-only guard is in the component** (§CORE-05) — dark graphite tile
  style, ember route + casing, start/finish markers; never renders another user's
  geometry (Phase 2 gate).
- **Type-metadata-driven UI:** the recording screen, detail, and Records are all
  functions of `activity_types` metadata (`supports_gps` / `is_distance_based` /
  `tracks_elevation`) — no per-type hardcoding.
- **Unhappy paths are specified above and are requirements:** GPS acquiring/weak/
  lost, location declined/revoked, crash-recovery resume, offline finish + sync
  failure, map-tiles-offline, manual (no-route) activity, empty history/records,
  first-ever-of-type PR, iOS-no-Health-Connect. Each has copy above.
- **Accessibility floor (not a tradeoff):** every control ≥ `touchTarget.min` (Start/
  Pause/Finish sized generously for mid-run use); the balance/hero-swap and any
  slider are proper adjustable roles with value announcements; GPS/PR/sync status
  each carry a non-color signal (label + glyph), never color alone; `RouteMap` and
  live regions have a11y labels; reduced-motion honored on every animated element.

---

## Judgment calls & ambiguities flagged for product/architecture review

1. **Hero metric default = Duration** (not Distance/Pace). The doc lists the live
   metrics but doesn't rank them; Duration is chosen because it's the only one that
   survives a no-GPS/manual/declined-location activity and is the spine currency.
   Swappable by tap. Confirm this matches how you expect runners to use it.
2. **Live clock = moving time; Elapsed shown secondary.** The model distinguishes
   `moving_time_seconds` from the spine `duration_seconds`; I made moving time the
   headline (runner expectation) and elapsed the secondary. **Manual pause only** —
   auto-pause is not designed here; flag if you want it in Phase 1.
3. **Live "current pace" is device-derived and not persisted** (only
   `average_speed_mps` is stored → "Avg pace" on detail). Confirm there's no
   requirement to persist a live/instant-pace stream (there isn't one in the model).
4. **Kudos surfaced once, display-only, on detail — not on Log rows.** The task
   allows a 0-count affordance; I judged per-row "0 kudos" to read as broken/social
   on a private log, so it appears only once on detail as a reserved, non-interactive
   spot. This is a product-voice call — confirm.
5. **Optimistic offline PR celebration, reconciled on sync.** The architecture puts
   `achievements` on the server RPC but expects offline recording; celebrating
   instantly requires an on-device optimistic check against the local
   `personal_records` cache, reconciled with the server. The model supports it (§9
   local cache), but the doc doesn't state the celebration is optimistic — needs
   `backend-builder`/`mobile-builder` alignment so the two can't diverge visibly.
6. **No PR-celebration color / dark map style are design calls** beyond the doc: PRs
   reuse ember + growth + the Meridian (no new hue — `tokens.md §2.1`); the map uses
   a custom dark graphite tile style, not the platform default. Both are deliberate
   anti-generic decisions, noted so `design-reviewer` can see intent.
7. **Record launch = FAB (Meridian glyph), not a tab-bar center button**, to avoid
   forcing an icon set this project deferred (P0 `_layout` comment). Revisit when an
   icon system is designed.
8. **Finish reachable only from Paused** (a deliberate mis-tap safeguard) — a UX
   invariant not in the data model. Confirm it's acceptable that ending a run is
   always a two-step (Pause → Finish).
