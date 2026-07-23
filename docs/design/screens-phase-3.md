# MileLift — Phase 3 Screen Specs (Module B · Nutrition & Food Logging)

Status: **v1, CONFIRMED — all design decisions settled, including the four questions
resolved by the person 2026-07-22 (see §Decisions).** Consumer: `mobile-builder` (build
directly against this; do not re-derive decisions). This **extends** the Phase 0 +
Phase 1 + Phase 2 system — every value is a named token from `docs/design/theme.ts`,
every screen inherits the Phase 0 component vocabulary (`screens-phase-0.md §A`), the
Phase 1 additions (§A), the Phase 2 additions (§A), and the precise-plainspoken-coach
voice (`tokens.md §1`). If you want a literal, that's a missing token — add it to
`theme.ts` first.

Covers CORE-06 … CORE-11 UI, designed against `docs/architecture/phase-3-module-b.md`
(the CONFIRMED data model; §-refs below are to that doc unless prefixed `P0`/`P1`/`P2`)
and the four live RPC contracts: `docs/api/search-foods-and-resolve-barcode-v1.md`
(`SEARCH`/`BARCODE` refs), `docs/api/save-food-log-entry-v1.md` (`SAVE`/`SAVEDMEAL`
refs), `docs/api/save-water-and-manual-burn-v1.md` (`WATER`/`BURN` refs), and
`docs/api/daily-energy-balance-and-macros-v1.md` (`BALANCE`/`MACROS` refs).

Scope guardrail: **Module B UI only** — food search + log against the live catalog
(411 real foods now, growing) and multi-item meal logging (CORE-06), barcode scan →
resolve → log with the explicit no-dead-end miss path (CORE-07), the daily energy
ledger + macro breakdown incl. the CORE-11 cross-module reconciliation surface
(CORE-08/11), water quick-log (CORE-09), saved meals (CORE-10), manual calorie-burn
logging with the soft overlap advisory (CORE-11), custom-food creation, the nutrition
sources/credits gate surface, and offline sync-status treatment throughout. **Not** in
scope (built so the surface doesn't look broken by their absence): the **macro/calorie
goal & target model** (out of Phase 3 per §12 decision 5 — the app shows net **actuals**,
never "remaining vs. goal"; no goal ring, no target marker); **AI meal-parse from
photo/text** (AI-09, Phase 5 — the log flow reserves the `source = ai_parsed` /
`needs_confirmation` slot but ships no camera-meal-parse and no photo capture for food);
**community-shared meals** (Phase 4 widening — saved meals are owner-only now);
**upstream contribution of custom foods back to Open Food Facts** (§12 decision 6); the
cross-module unified **Home** dashboard (still a Phase-1-deferred Home concern — a meal
IS a `timeline_events` row and *will* join the unified timeline there; in Phase 3 its
history lives under the Food tab, §B).

---

## 0. Why this phase looks the way it does (the one idea)

Phase 0 established the **Mile ↔ Lift duality** and the **Meridian** signature: a warm
**horizontal** Mile axis (ember) and a cool **vertical** Lift axis (cyan) meeting at an
**origin**. Phase 1 made the **horizontal axis** a working instrument — a recorded run
*draws* the ember `MeridianTrace`. Phase 2 made the **vertical axis** a working
instrument — a completed set *raises* the cyan `LiftStack`.

**Phase 3 lights the third and last part of the mark: the origin itself.**

> **A day's food and movement balance the origin.** Where a run draws the Mile axis and
> a lift raises the Lift axis, nutrition operates on the **point where the two axes
> meet** — the energy origin, "where you are right now." Food is energy *in*; it pushes
> the origin **warm** (ember). Every calorie *out* — a Mile-axis run, a Lift-axis
> workout, a manual burn — pulls it **cool** (cyan). Where the origin settles between
> the warm intake mass and the cool expenditure mass **is your net for the day**. This
> is the `MeridianBalance`. It is not a new metaphor bolted onto nutrition — it is the
> exact reason this module exists: nutrition is the one module that touches **both**
> disciplines, and CORE-11's whole thesis is that a run and a lift show up in one
> energy ledger. The Meridian mark said that from day one (two axes, one origin);
> Module B is where the origin becomes real.

This is the deliberate answer to nutrition-logging's single biggest cliché, chosen on
purpose, not defaulted into:

- **Not a calorie ring, and not three arbitrarily-colored macro donuts.** Every
  competitor (MyFitnessPal, Lose It, Cronometer) leads with a ring filling toward a
  goal, or a trio of red/blue/yellow macro circles. Both are ruled out in the
  anti-generic ledger (`tokens.md §7`). The ring is also **structurally wrong for
  Phase 3**: it implies a *goal to fill toward*, and Phase 3 has **no goal model**
  (§12 decision 5). The `MeridianBalance` shows **net actuals** around an origin, with
  no target — honest about what the data is.
- **Not a goal-centric surface at all.** Where the whole category frames the day as
  "1,240 of 2,000 calories," Phase 3 frames it as "you took in X, you spent Y, you're at
  net Z" — because that's the only truthful thing the RPCs return (`BALANCE §2.2`: no
  goal field). Making a virtue of it: the balance is the most on-thesis possible read of
  the data, and it makes the cross-module win **visible** — you literally see the ember
  of your run and the cyan of your lift summed into today's "out."
- **Macros are a distribution, so they're horizontal bars, not a ring** — the same rule
  Phase 2 set (`P2 §CORE-15`: time series = vertical columns, distribution = horizontal
  bars). Protein / carb / fat are three length-encoded bars in the ember intake family,
  the metric face carrying the grams. Monochrome on purpose: the arbitrary-3-color macro
  palette is the exact "unreviewed default" the audit exists to catch.

In the future unified timeline, a run renders as a horizontal ember trace, a lift as a
vertical cyan stack, and a day's energy as the origin balancing between them — one mark,
three instruments, all unmistakably Meridian.

---

## A. New component vocabulary (Phase 3 adds these; compose, don't re-style)

Defined once here; screens below reference them. All inherit Phase 0 §A / Phase 1 §A /
Phase 2 §A patterns. Numbers everywhere use the **metric face**
(`fontVariation.metric`, tabular) — non-negotiable, it is the app's content
(`tokens.md §3`).

- **MeridianBalance** — the signature applied to nutrition. The energy origin made a
  working instrument, the counterpart to `MeridianTrace` (Mile axis) and `LiftStack`
  (Lift axis). A **horizontal beam that pivots on the Meridian origin dot**
  (`energyBalance.origin`): the **intake mass** (`energyBalance.intake`, ember) accretes
  on the warm side, the **expenditure mass** (`energyBalance.expenditure`, cyan) on the
  cool side, and the origin rests where they balance — its offset from center **is the
  net**. Deliberately anchored at the **center/origin**, not a left edge, so it reads as
  a *balance*, distinct from `MeridianTrace`'s left-anchored *growth*.
  - `live` variant (Food → Today): the running day. Intake grows warm as meals are
    logged; expenditure grows cool as burns/tracked-workouts land; the origin re-settles
    with a `spring.settle`. The signed **net** is a `MetricStat` (`type.metricLg`) at the
    origin. **No goal marker, no fill-to-100%** — it is a living balance, not a progress
    bar (a day has no target in Phase 3). Tapping it expands the expenditure breakdown
    (§CORE-08/11).
  - `static` variant (day-history row / post-log confirmation): renders the day's
    settled balance as a compact horizontal micro — the shape of "how the day went."
  - `empty`/first-of-day: the origin dot + a faint horizontal baseline only, no mass.
  - Reduced motion: masses and the origin appear in their settled positions without the
    accretion/settle easing (same rule as `MeridianTrace`/`LiftStack` — data updates,
    decoration doesn't).
  - **a11y:** the beam has a text summary label ("In 1,850 · Out 620 · Net +1,230
    kcal"); color is never the only signal (the "in"/"out"/"net" labels + signed number
    carry it).
- **MacroBreakdown** — the CORE-08 macro composition of intake. **Three horizontal
  bars** (Protein · Carb · Fat), length ∝ grams, all in the **ember intake family**
  (`energyBalance.intake` fill on a `bg.inset` track) — **monochrome by deliberate
  decision** (the anti-3-color-macro-donut choice, §0). Each bar: an `type.overline`
  label (PROTEIN/CARB/FAT), the grams in the metric face (`type.metricSm`), and a small
  `text.secondary` share (e.g. "42%") when useful. **No target ring, no goal segment.**
  Subordinate in weight to the `MeridianBalance` (it's the itemization of the warm side,
  not a second hero).
- **FoodSearchRow** — one `search_foods_v1` result: `name` (`type.bodyStrong`), `brand`
  (`text.secondary`), a compact per-serving line in the metric face (kcal · P/C/F for
  the food's default serving), a **`SourceTag`**, and a **`DataQualityTag`** when
  `data_quality != high`. A scannable list row, **not** a card grid. Tapping opens the
  **Log sheet** for that food.
- **ServingControl** — the log-ergonomics core (the fastest-path input, §CORE-06). A
  **serving picker** (the food's `food_servings`, default pre-selected — `SEARCH`/
  `BARCODE` return `default_serving`/`servings`) + a **quantity stepper** in the metric
  face (−/＋ and direct entry, `≥ touchTarget.min`). Live-recomputes the resolved kcal +
  P/C/F **on-device** from the snapshot math (`grams = quantity × serving_g_or_ml`;
  `macros = grams/100 × per-basis`) — the numbers the user sees are the numbers
  snapshotted at save (`SAVE §2.3` — all snapshots are client-supplied). Metadata-driven:
  a `per_100ml` food shows ml servings, a `per_100g` food shows gram servings.
- **FoodLogItemRow** — one logged food inside a meal: `food_name_snapshot`, the
  frozen serving + quantity (`serving_label_snapshot` × `quantity`, metric face), the
  item kcal (metric face), a macro micro-line, and — in edit mode — a remove affordance
  (which **tombstones** via `deleted_at`, never omits, §CORE-06). Reads its own snapshot,
  never a live food lookup (§3).
- **MealCard** — one eating occasion grouped by `meal_type` (Breakfast · Lunch · Dinner
  · Snack · Other): header (meal type + optional `title` + time), its `FoodLogItemRow`s,
  the meal `total_energy_kcal` + macro line (the snapshot totals, `SAVE §2.4`), and a
  `SyncStatusPill` when unsynced. **＋ Add food** to append to this meal (incremental
  `save_food_log_entry_v1`).
- **ExpenditureRow** — one line in the CORE-11 calories-out breakdown, from
  `BALANCE.expenditure_events[]`. A **provenance tag** (`type.overline`, non-color) —
  **TRACKED · RUN** (`gps_activity`), **TRACKED · LIFT** (`strength_session`), or
  **MANUAL** (`manual_calorie_burn`) — a name (the manual burn's `label`, or a derived
  "Run"/"Workout" for tracked rows), and the `−kcal` in the metric face. Tracked rows are
  **tappable through** to the source activity/workout detail (cross-module nav via
  `timeline_event_id`); manual rows are tappable to edit. This is where CORE-11
  attribution is legible: each contributing event shown **once**, clearly labeled
  tracked-vs-manual (the double-counting design made visible, §4).
- **WaterQuickAdd** — the CORE-09 fast logger (§CORE-09). A row of **preset chips**
  (`radius.pill`) in the user's `unit_volume` (e.g. 250 ml · 500 ml · 750 ml, or fl-oz
  equivalents) + a **Custom** entry; each chip is a **one-tap immediate log**
  (`save_water_intake_v1`). Plus the day's running total (`MACROS.water_ml_total`) as a
  slim horizontal **cyan accretion** (`energyBalance.water`), deliberately **off** the
  energy beam (water is not `energy_kcal`) and **without a goal target**.
- **OverlapAdvisory** — the CORE-11 soft, non-blocking overlap note (§CORE-11). A
  **dismissible `InlineBanner`** (`feedback.warningTint`), shown **after** a manual burn
  has already saved (the RPC returns `overlap_advisory` in its *success* body, `BURN
  §3.2/§3.3`) — **never a modal, never a blocker.** Names the overlapping tracked event
  and offers **Keep both** (dismiss) / **Remove this burn** (soft-delete the just-saved
  burn). Both entries keep counting until the user acts (§4.3).
- **SourceTag** — a per-food provenance pill (`type.overline`, `bg.inset`,
  **`text.secondary`** — see §Contrast): **USDA** (`usda_fdc`), **Open Food Facts**
  (`open_food_facts`), **Custom** (a `custom_foods` row), **MileLift** (`milelift_authored`).
  Metadata, not status — not brand-colored. Doubles as the entry point to the
  **Nutrition sources** credits (the in-app attribution gate, §CORE-Credits).
- **DataQualityTag** — the `nutrition-data-standards` confidence signal, from
  `data_quality`. Rendered **only** for `medium`/`low` (a `high` food shows nothing —
  no clutter). `low` carries a non-color caution glyph + `text.secondary` label
  "Community data — check it" and drives the low-confidence confirm affordance (§CORE-06
  / §6). Never color-only.
- **ScanFrame** — the CORE-07 camera scan surface (§CORE-07): a live camera preview with
  a Meridian-origin-cornered reticle, a torch toggle, and a "point at the barcode" hint.
  Owns the camera at the `camera` consent point of use (E3).

Reused verbatim (do **not** re-style): `MetricStat` / `MetricBar` / `WeekHeader`
(P1 §A), `SyncStatusPill` (P0 §A, **with the Phase 2 `local` "Saved on device" state**,
§CORE-Sync), `ConsentSheet` (P0 §E — the **E3 camera** sheet is reused for the scanner;
the **E1 health** sheet gates only estimated-burn, §CORE-11), `MeridianMark` (all
variants — FAB glyph + empty-state seeds), `Field` / `PrimaryButton` /
`SecondaryButton` / `TextButton` / `SegmentedControl` / `InlineBanner` (P0 §A).

---

## B. Navigation & app-shell changes (`app/(app)/_layout.tsx`)

Phase 2 shipped **Home · Activity · Lift · Profile** (four text labels, no invented icon
set — a standing discipline). Phase 3 keeps that discipline and adds one tab:

- **Tabs become: Home · Activity · Lift · Food · Profile** — five text labels, no new
  icon set. The new tab is **"Food"** — the plainspoken word, consistent with the
  literal-discipline naming of "Activity" and "Lift" (chosen over a branded coinage like
  "Fuel" — §Decisions D1). Home stays the Phase 0/1/2 placeholder —
  the real cross-module dashboard, where meals/runs/lifts share one timeline and one
  energy origin, remains explicitly out of scope (§0 scope guardrail). (Five tabs is the
  practical ceiling for the bottom bar; the eventual Home unification is the pressure
  valve — noted, not built.)
- **Food tab** (`app/(app)/food.tsx`) is **day-first** — a deliberate departure from the
  history-first Activity/Lift tabs, justified because nutrition is inherently a *today*
  surface (you log against today and check today's balance many times a day), where a run
  or a workout is a discrete event you browse historically. A segmented header **Today |
  History** (`SegmentedControl`, `radius.pill`). `Today` is the CORE-08/11 energy ledger
  (§CORE-08). `History` is the by-day log timeline (§CORE-08 History).
- **Log FAB** — bottom-right of the Food tab, thumb-reachable, an `accent.primary`
  circle carrying the **Meridian origin glyph** (the same FAB pattern as Activity/Lift,
  a defined glyph not a new icon). a11y label "Log food." Tapping opens the **Log sheet**:
  **Search food** · **Scan a barcode ▸** (§CORE-07) · **Saved meals ▸** (§CORE-10) ·
  **Add water** (opens `WaterQuickAdd`, §CORE-09) · **Log a burn** (§CORE-11). Water is
  *also* directly one-tap from the Today screen's water strip (§CORE-09) — the Log sheet
  is the complete menu, the Today strip is the fast path.
- **Food log / search** is a **modal route** (`app/(app)/food/log.tsx`, presented
  modally) — a focused task. **Barcode scan** (`app/(app)/food/scan.tsx`, modal,
  keep-awake camera), **meal detail/edit** (`app/(app)/food/meal/[id].tsx`, pushed),
  **saved meals + builder** (`app/(app)/saved-meals.tsx` + `.../saved-meals/[id].tsx`),
  **custom-food create/edit** (`app/(app)/custom-food.tsx`, modal), and **nutrition
  credits** (`app/(app)/nutrition-credits.tsx`, pushed) are routes; water and burn logging
  are bottom sheets over the Food tab. `mobile-builder` owns exact route mechanics.

---

## CORE-06 — Food search + logging (`app/(app)/food/log.tsx`) — the core

The **highest-frequency, fastest-path** screen in the module (logging speed is a top
churn lever, §13 — treated with the same care Phase 1 gave recording and Phase 2 gave
set-logging). **Legibility and the numeric face rank above every decorative choice
here.** Two things happen on this surface: **search the catalog** and **build a meal**
(one or many foods) then save it.

### Search
- **Search bar pinned top**, calling `search_foods_v1(query, cursor, limit)` — debounced,
  **cursor-paginated, never unranged** (the `max_rows` guard, §2.2; the client MUST NOT
  ever `.select()` `foods`). A subtle bottom loader on scroll; "That's every match." at
  the true end (`next_cursor == null`).
- Results are **`FoodSearchRow`s** — name, brand, per-serving kcal + P/C/F (metric
  face), `SourceTag`, `DataQualityTag` (only when `medium`/`low`). Ranking is the RPC's
  (`SEARCH §3.2`), rendered in order — the client does not re-sort.
- **Offline:** search runs against the **bounded local cache** — the curated common-foods
  subset + the user's own recent/saved/custom foods (§2.4/§9) — never the full catalog
  (which is server-only). An `InlineBanner` (`feedback.infoTint`) states it honestly when
  offline: *"Offline — searching your recent foods and common items. Full search is back
  when you reconnect."* Full-catalog matches fill in on reconnect.
- **My foods / custom:** a filter chip surfaces the user's `custom_foods` (read directly
  under RLS, not via the search RPC — `BARCODE §4` note).

### The Log sheet (one food) — the fast path
Tapping a `FoodSearchRow` opens a compact bottom sheet:
- The food name + `SourceTag`; the **`ServingControl`** (serving picker + quantity
  stepper) with a **live resolved readout** (kcal + P/C/F for the chosen quantity, metric
  face) that updates as the user adjusts — this is the number that gets snapshotted.
- A **meal-type selector** (Breakfast · Lunch · Dinner · Snack — smart default from
  time-of-day) so a single food logs straight into the right occasion.
- **`DataQualityTag` = low → a confirm affordance** (not a block, §6): the resolved kcal
  is shown large with an inline caution — *"This is community-sourced and may be off —
  check the calories before you log."* The user can edit the values inline (which writes
  the corrected snapshot) or log as-is. `data_quality_snapshot` is carried either way.
- Primary: **"Log food."** Confirmation mirrors: **"Food logged."** — and the Today
  balance's intake side visibly grows (a `MeridianBalance:static` echo in the toast).

### The Meal builder (multiple foods at once) — CORE-06 "log a full meal"
When the user wants to log several foods as one occasion (the architecture's meal grain,
§1.5 — one `food_log_entry` with an items child collection):
- A **draft meal tray** accretes as the user adds foods from search/scan/saved without
  leaving the log surface — each **Add** appends a `food_log_item` to the local draft
  (client-generated `id` per item, the second idempotency grain, §9/`SAVE §2.1`).
- A pinned **running total** (kcal + P/C/F, metric face) updates as items are added — the
  meal's shape before it's saved.
- Each draft item is a `FoodLogItemRow` with inline quantity edit and remove.
- **Save the whole meal** → `save_food_log_entry_v1(p_id, …, p_items[])` in **one
  transaction** (spine + `food_log_entries` + N items; totals + spine `energy_kcal`
  server-recomputed, `SAVE §2.4`). Confirmation: **"Meal logged."**
- **Add to an existing meal** (from a `MealCard`'s ＋ Add food): the same RPC with the
  meal's existing `p_id` and only the new items — **upsert-present, the already-committed
  items are untouched** (`SAVE §2.1` — never delete-omitted). A removed item is an
  explicit `deleted_at` in the payload, never an omission.

### States
- **Empty (no query yet):** not "No results" — a `MeridianMark:seed` + *"Search a food,
  scan a barcode, or start from a saved meal."* + shortcuts to Scan / Saved meals.
- **Search empty (no match):** the differentiated moment — *"No match for 'labneh.' Add
  it as your own food?"* → routes to custom-food creation (§CORE-Custom), prefilling the
  query as the name. Never a dead "0 results."
- **Logging offline (the norm, the gate test):** the whole flow works; the meal saves to
  local SQLite immediately, appears in Today with **"Saved on device"** (the `local`
  pill), and `save_food_log_entry_v1` runs on reconnect, idempotently (two grains: meal
  `id` + per-item `id`, §9). **Save is never blocked on network.** The gate's
  "two copies of my breakfast" bug is designed out: every write is `INSERT … ON CONFLICT
  (id) DO UPDATE`, retries are safe (`SAVE §2.1`).
- **Save error (on later sync):** the `MealCard`'s `SyncStatusPill` shows "Sync failed ·
  retry"; the meal and every item are preserved locally, never dropped. Tap retries the
  same idempotent call.
- **Consent — estimated data:** ordinary food logging is **not** consent-gated (§12
  decision 3) — no sheet, ever. (The only Module B consent is on *estimated manual burn*,
  §CORE-11.)
- **Success:** sheet dismisses to Today, the meal present in its occasion.

### Motion
- The intake accretion on the `MeridianBalance` is the earned moment (a meal logged) —
  reserved, not decorative. Running totals update continuously (data). Reduced motion:
  no accretion easing; values and masses still update.

---

## CORE-07 — Barcode scanning (`app/(app)/food/scan.tsx`)

Camera-based scan → `resolve_barcode_v1` → log, with an **explicit, non-dead-end miss
path** (§2.4 — a miss lets the user create a custom food, never hits a wall).

### The flow
1. **Camera consent at point of use (reuse E3 — do NOT reinvent).** First scan without an
   active `camera` consent → the **existing** `ConsentSheet` `category="camera"` (the E3
   priming sheet, precedes the OS prompt, P0 §E rule 5). Decline / OS-denied → **manual
   search still works** (the scanner degrades gracefully, §10) with an `InlineBanner`:
   *"Camera's off — search for the food by name instead, or turn on the camera."* Never a
   crash, never a dead scan screen.
2. **Scan (`ScanFrame`):** live preview, origin-cornered reticle, torch toggle. On a
   detected barcode, resolve in this order (§2.4):
   - **Local cache first** (offline-capable, fast): the common-barcode subset + the user's
     own custom foods carrying that barcode.
   - **On a local miss and online:** `resolve_barcode_v1(barcode)` against the full server
     catalog.
3. **Hit** → straight into the **Log sheet** (§CORE-06) prefilled with the resolved food +
   its `servings` (default pre-selected). Same `DataQualityTag` confirm rule applies — a
   barcode match is **not** automatically high-confidence (§2.4 step 4). "Log food" as
   normal.
4. **Miss — the explicit non-dead-end** (`BARCODE_NOT_FOUND`, or a local miss while
   offline): **route to custom-food creation** (§CORE-Custom), **prefilling the scanned
   `barcode`** so a re-scan later resolves to the user's own entry (§2.4 step 3). Copy is
   an invitation, not an error: *"No match for this barcode yet. Add it as your own food —
   scan it next time and it's yours instantly."* The offline-queued barcode is also retried
   against the server on reconnect.

### States
- **Scanning:** live reticle; a quiet hint. On a blurry/no-read after a few seconds:
  *"Can't read it — hold steady, or search by name."* + a **Search instead** `TextButton`
  (never trap the user in the camera).
- **Resolving (online lookup):** a brief inline spinner on the reticle; the camera stays
  live. Not a full-screen block.
- **Offline miss:** the custom-food path (step 4) opens immediately — no spinner waiting on
  a network that isn't there.
- **Torch/permission edge:** torch unavailable → hide the toggle; camera revoked mid-session
  → fall back to the manual-search banner (P0 §E revoked pattern).

---

## CORE-08 — Daily energy ledger + macro tracking (Food → Today) — the signature surface

The CORE-08 macro dashboard **and** the CORE-11 reconciliation surface, on one screen.
This is where the `MeridianBalance` goes big.

### Layout (Today, top → bottom)
1. **`MeridianBalance:live` (the hero).** The day's energy origin balancing between warm
   intake and cool expenditure, from `get_daily_energy_balance_v1(local_date)`. The signed
   **net** (`net_kcal`) is the `MetricStat` at the origin (metric face, `type.metricLg`),
   with **"in"** (`calories_in_kcal`) and **"out"** (`calories_out_kcal`) labeled on the
   warm and cool sides. **No goal marker** (§0/§12 decision 5) — a one-line
   `text.secondary` note states it once so the absence reads as intentional, not missing:
   *"Net so far today — MileLift tracks what you took in and burned, not a target."*
2. **`MacroBreakdown`.** Protein · Carb · Fat from `get_daily_macros_v1(local_date)`
   (`total_protein_g`/`carb_g`/`fat_g`), the three monochrome ember bars + metric-face
   grams. The itemization of the warm intake side — subordinate to the beam.
3. **Expenditure breakdown (CORE-11 — tap the beam or a "Calories out" header to expand).**
   A list of **`ExpenditureRow`s** from `BALANCE.expenditure_events[]`, each provenance-
   tagged **TRACKED · RUN** / **TRACKED · LIFT** / **MANUAL** and showing its `−kcal`
   (metric face). This is the concrete CORE-11 payoff: **a Module A run and a Module C
   workout appear here — once each, automatically — alongside any manual burn, clearly
   attributed** (§4). Tracked rows tap through to their source detail; manual rows tap to
   edit. Copy at the top: *"Everything you burned today — your tracked runs and lifts, plus
   anything you logged by hand."*
4. **Water strip.** The day's hydration (`WaterQuickAdd` compact form): the cyan accretion
   + total + the one-tap preset chips (§CORE-09). Visually **separated** from the energy
   beam (water is not energy).
5. **Meals list.** The day's `MealCard`s grouped by `meal_type` in occasion order — each
   with its items, snapshot totals, `SyncStatusPill`, and ＋ Add food. The **Log FAB**
   floats over all of it.

### History (Food → History segment)
A **by-day timeline** (not a per-meal feed) — nutrition accumulates into days, so the row
grain is the day, mirroring the "training adds up" framing (P1/P2 `WeekHeader`s):
- **`WeekHeader`s** carry the week's aggregate (avg daily net, or total intake — metric
  face).
- One **day row** per logged day: the date, a **`MeridianBalance:static` micro** (the
  day's settled shape), in/out/net (metric face), meal count. Tapping opens that day
  (the same Today layout, read for a past `local_date`).
- **Pagination:** cursor-based on `(occurred_at, id)` (§5), never offset; "That's the start
  of your food log." at the true end.

### States
- **Loading:** skeleton beam + skeleton macro bars + skeleton meal cards — never a spinner
  on blank.
- **Empty (nothing logged today):** `MeridianBalance:empty` (origin + faint baseline) +
  `type.title` **"The day starts at the origin."** + *"Log your first food and it settles
  here — everything you eat and burn balances against this point."* + the Log FAB. Not
  "No data."
- **Only expenditure, no food (a run logged, nothing eaten yet):** the origin sits fully
  cool; net is a negative number; copy stays neutral (no "you're behind" — there's no
  goal). *"You've burned {X} and logged no food yet today."*
- **Offline / cold-start load failed:** `InlineBanner` (`feedback.warningTint`): *"Couldn't
  refresh today's totals — you may be offline. Anything you've logged on this device is
  still here."* The beam renders from local data; never a full-screen wall if local data
  exists.

### Motion
- Origin re-settle (`spring.settle`) when a meal/burn lands — the earned moment. Masses
  accrete at `duration.base`. Reduced motion: settled positions, no easing.

---

## CORE-09 — Water intake (`WaterQuickAdd`) — the fast, low-friction surface

The simplest CORE item, deliberately the **fastest** (it's logged many times a day, §13).

- **One-tap presets:** `radius.pill` chips in the user's `unit_volume` (`ml`/`fl_oz` from
  the profile) — a small set of common pours (e.g. **250 ml · 500 ml · 750 ml**, or the
  fl-oz equivalents). Tapping a chip **logs immediately** via `save_water_intake_v1`
  (client `id`, `volume_ml` canonical, `unit_volume_snapshot`) — no confirm step, no
  sheet. A light haptic + the accretion grows. Confirmation is the visible total change,
  not a toast (speed > ceremony here).
- **Custom** chip → a tiny inline numeric entry (metric face) for an off-preset amount.
- **The day's total** as a slim horizontal **cyan accretion** (`energyBalance.water`) +
  the metric-face total (from `MACROS.water_ml_total`). **No goal ring, no target line**
  (§12 decision 5) — just the running total.
- **Undo:** a just-logged drink is undoable for a few seconds (soft-delete the last
  `water_intake` event) — a mis-tap on a one-tap control must be reversible.

### States
- **Empty:** the presets + a faint empty accretion + *"Tap to log your first glass."*
- **Offline:** logs locally, `SyncStatusPill` on the day's water (`local` → syncs on
  reconnect). Never blocked.
- Not consent-gated (water is not biometric, §1.7/§12 decision 3).

---

## CORE-11 — Manual calorie-burn logging + the soft overlap advisory

A user logging expenditure for something Module A/C don't track (tennis, yoga, gardening),
via `save_manual_burn_v1` — **negative** `energy_kcal` on the spine, the Module B side of
the reconciliation (§4).

### The burn sheet
- **Label** (Field, required, free text — "Tennis", "Yoga class"; deliberately
  unstructured, §1.8).
- **Calories burned** (Field, metric face) — the magnitude; the RPC writes it **negative**
  (`p_energy_kcal < 0` strictly, `BURN §3.1`). The UI shows it as a positive "burned"
  figure and sends the negative.
- **Duration** (optional, minutes, metric face) — feeds `duration_seconds` **and the
  overlap-advisory window** (`BURN §3.3`; omitted → the RPC's 30-min default window).
- **When** (`occurred_at`, default now; edit for an earlier session).
- **Optional structured type** — pick from the Module A `activity_types` catalog
  (`p_activity_type_code`) if the user wants the burn tied to a known type; free-text is the
  default.
- **How the number was set** — **"I entered it"** (`user_entered`) vs **"Estimate it for
  me"** (`estimated`). **The estimate path is the one consent gate in Module B**
  (§CORE-11 consent below).
- Primary: **"Log burn."** Confirmation: **"Burn logged."**

### The soft, non-blocking overlap advisory (§4.3, §12 decision 2) — what "soft" actually looks like
Per the person's decision, this is a **SOFT, NON-BLOCKING advisory that never prevents
saving.** Concretely, because the RPC returns `overlap_advisory` in its **success** body —
the burn is **already saved** by the time the client sees the advisory (`BURN §3.2/§3.3`):

- **It is a dismissible inline `OverlapAdvisory` banner, never a modal, never a save
  blocker.** It appears **after** the successful save, on the confirmation / Today view,
  only when `has_overlap == true`.
- Copy names the specific overlapping tracked event(s) (from `overlapping_events[]`):
  *"Logged. Heads up — you already have a tracked workout in this window (Evening Run,
  −450 kcal) that's counted in today's burn. Both are counting now."*
- Two equal, non-coercive choices (no dark pattern): **Keep both** (dismiss — the honest
  default, since manual burns are usually genuinely additive, §4.3) and **Remove this
  burn** (soft-delete the just-saved `manual_calorie_burn` — an undo, not a block). Never
  auto-merge, never silently suppress: *"Only you know if this is the same session your
  watch logged."*
- Both entries keep counting in `get_daily_energy_balance_v1` regardless (§4.3) until the
  user removes one — the app never does it for them.

This is the deliberate contrast to a modal blocker: the user was **never stopped**, their
data was **never destroyed**, and the correction is a **one-tap undo** they choose.

### Consent — estimated burn only (reuse E1 health)
- **`estimated`** needs bodyweight, so it is gated on the existing **`health` consent**
  exactly like Module A/C energy estimation (§6/§1.8). Selecting "Estimate it for me"
  without an active `health` consent → the RPC returns `CONSENT_REQUIRED_HEALTH`
  (`BURN §3.4`); surface the **E1 health `ConsentSheet`** (priming precedes any OS/HealthKit
  ask, P0 §E) — never a raw error. Declining keeps the burn fully loggable via **"I entered
  it"** (`user_entered`, no consent needed). Ordinary `user_entered` burns are **never**
  gated.

### States
- **Offline:** logs locally (`local` pill) and syncs idempotently on reconnect. **The
  overlap advisory is also computed client-side from the local timeline** (source of truth,
  §4.3) so it works offline; the server re-checks on sync and the two agree (the same
  optimistic-then-reconciled seam as the PR badges — flagged for `mobile-builder`/
  `backend-builder` alignment, §CORE-Sync).
- **Invalid:** `energy_kcal >= 0` → the RPC rejects `INVALID_ENERGY_SIGN`; the UI prevents
  it at the boundary (a burn must be > 0 entered). `duration < 0` prevented likewise.
- **Success:** dismisses to Today; the burn appears as a **MANUAL**-tagged `ExpenditureRow`
  in the calories-out breakdown.

---

## CORE-10 — Saved meals (`app/(app)/saved-meals.tsx`)

Reusable named food bundles, logged in one action (`log_saved_meal_v1`). Owner-owned
*definitions, not events* (the `workout_templates` precedent, §1.10). **The critical UX
truth: a saved meal is a LIVE plan, not a frozen snapshot** — logging it **re-resolves the
foods' current macros** at log time (`SAVEDMEAL §3` / §1.10), so the UI must never imply
the macros are frozen into the saved meal.

### Saved meals landing
- A list of the user's `saved_meals` (name, item count, a `text.secondary` current-macro
  line). **＋ New saved meal.**
- Each row's primary action is **"Log it"** — one tap expands the meal into a new
  `food_log_entry` via `log_saved_meal_v1` (server-authoritative snapshot of *current*
  macros). Confirmation: **"Meal logged."**

### Saved-meal builder (`app/(app)/saved-meals/[id].tsx`)
- **Name** (required), optional description, optional default `meal_type`.
- An ordered list of foods (add from search/scan), each with a serving + quantity — but
  **no macro snapshot shown as if fixed.** The macro line is explicitly framed as **live**:
  *"Macros update from the latest food data each time you log this — so a corrected food
  improves every future log."* (The direct parallel to a workout template's target reps
  pointing at the current exercise, §1.10.) This is the anti-"frozen snapshot" copy the
  task calls for.
- Save → owner-owned, offline-first, `SyncStatusPill`. Delete → soft-delete; confirm names
  that **history is untouched**: *"Delete this saved meal? Meals you've already logged from
  it stay in your history."* (log-time snapshot, §3.)

### Log-time behavior — online vs. offline (DECIDED, §Decisions D3 / former OQ-3)
- **Online:** "Log it" calls `log_saved_meal_v1`, which re-resolves each item's **current**
  catalog macros server-side and writes a new `food_log_entry` (`SAVEDMEAL §3`). This is the
  authoritative path and the reason a saved meal is a live plan, not a frozen snapshot.
- **Offline: expand-with-cached-macros immediately — never blocked, never queued-until-online.**
  Because `log_saved_meal_v1` is single-shot online-only by design (it must read the current
  catalog, which isn't on-device, `SAVEDMEAL §3.2`), the offline "Log it" path does **not**
  wait for a connection. It **expands the saved meal's items into local `food_log_items` right
  then**, using each item's **last-known/cached macros** (from the on-device common-food cache,
  the user's `custom_foods`, or the most recent prior resolution of that food), and saves via
  the offline-first `save_food_log_entry_v1` (client meal `id` + per-item `id`, §9). The meal
  appears in Today immediately with the `local` "Saved on device" pill and syncs idempotently on
  reconnect — **matching the offline-first behavior of every other log in the app** (a saved-meal
  log is never a second-class, connection-gated action). The item snapshots are the cached values
  at expansion time (§3 snapshot discipline holds — a later catalog correction improves *future*
  logs, not this already-logged one), exactly as a normal offline food log behaves. No
  "will log when you reconnect" deferral, no dimmed button.
  - **Honesty nuance (not a blocker):** if any item in the saved meal has **never been resolved
    on this device** (no cached macros to expand — e.g. a brand-new saved meal built on another
    device, first logged here while offline), that specific meal's "Log it" shows a one-line note
    — *"One food here hasn't loaded on this device yet — connect once to log this meal"* — rather
    than fabricating a macro figure. This is the narrow, honest exception; the common case (foods
    the user has logged before) expands instantly offline.
- If a food in the saved meal has gone stale (`FOOD_UNAVAILABLE`/`CUSTOM_FOOD_UNAVAILABLE`,
  `SAVEDMEAL §3.5`), the RPC fails the whole log rather than silently dropping an item —
  surface it specifically: *"One food in this meal isn't available anymore — open the meal
  to fix it."* + a route to the builder. Never a silent partial log.

### States
- **Empty:** `MeridianMark:seed` + *"Build a meal once, log it in one tap forever after."*
  + **＋ New saved meal.**
- **Offline:** browse/create/edit locally; "Log it" expands with cached macros immediately
  (§Decisions D3), never blocked.

---

## CORE-Custom — Custom food creation (`app/(app)/custom-food.tsx`)

The barcode-miss landing spot **and** a general "add my own food" flow (§1.4/§2.4).

- **Entry points:** the search empty-state ("Add it as your own food"), the barcode-miss
  path (prefilling the scanned `barcode`), and a "＋ Create a food" row in search.
- **Form** (plain, fast): **Name** (required); optional **Brand**; **Measured per** —
  **100 g** or **100 ml** (`basis`, the canonical-unit choice, framed plainly: "Are these
  numbers per 100 g, or per 100 ml?"); **Calories** (per basis, required); optional
  **Protein / Carb / Fat** (per basis); an optional **default serving** (g or ml,
  `default_serving_g_or_ml`); optional notes.
- **Owner-only, offline-first:** client-generated UUID, saved to local SQLite, works in
  airplane mode (the barcode-miss path **must** work offline, §2.4/§1.4); `SyncStatusPill`
  on the row. Appears immediately under **My foods** and is loggable at once; a re-scan of
  its barcode resolves to it.
- Confirmation mirrors the verb: **"Food saved."**
- **`SourceTag` = Custom** everywhere it appears; a custom food carries no `data_quality`
  caution (the user authored it).

### States
- **Offline:** full create locally; never blocked (this is the whole point of the miss
  path).
- **Barcode already yours (re-create attempt):** if the scanned barcode already matches one
  of the user's custom foods, skip creation and go straight to logging it (§2.4 — a
  correction is retained, not overwritten).

---

## CORE-Credits — Nutrition sources & attribution (`app/(app)/nutrition-credits.tsx`) — a GATE requirement

**This ships in-app; it is a licensing requirement, not optional polish** (§2.1/§6/§12
decision 1 — "attribution requirements for both data sources are actually visible in the
shipped app"). It mirrors Module C's `exercise-credits.tsx` pattern, but the two sources
have **genuinely different obligations** — do not copy the CC-BY-SA copy verbatim:

- **USDA FoodData Central** — **public domain**; no legal attribution requirement, but
  USDA **requests citation** and it is good practice. Copy (factual, not marketing):
  *"USDA FoodData Central — public domain. Generic and whole-food data is from the U.S.
  Department of Agriculture, Agricultural Research Service, FoodData Central. Cited as good
  practice; no attribution is legally required."*
- **Open Food Facts** — **Open Database License (ODbL) v1.0**, which — unlike public domain
  and unlike CC-BY-SA — carries a **real, specific legal obligation**: **attribution** to
  Open Food Facts **and** a **share-alike** term on any redistributed *database*. Copy:
  *"Open Food Facts — © Open Food Facts contributors, made available under the Open
  Database License (ODbL) v1.0. Branded and barcoded product data comes from the Open Food
  Facts community database. Under ODbL, this data stays open: attribution and share-alike
  apply."* A link out to `openfoodfacts.org` and to the ODbL text. (ODbL's share-alike
  attaches to a redistributed *database*, and its attribution/keep-open notice must be
  shown for the data as used — which is why this credits surface and the per-food `SourceTag`
  both exist; confirm exact ODbL wording with legal before public launch, the pre-launch
  sign-off item §12.)
- **MileLift-authored** — *"Foods written and owned by MileLift."*
- **Your own foods** — a plain note that custom foods are the user's own and are not
  redistributed.

**Where it lives — both, deliberately:**
1. **A dedicated screen** (`nutrition-credits.tsx`), reachable from the Food tab and from
   Profile (matching where exercise credits live), listing all sources + licenses, plain
   and factual.
2. **Inline per-food disclosure** — every food's `SourceTag` (USDA / Open Food Facts /
   Custom / MileLift) is visible at the point of logging and in history, and the food's
   `attribution` string (from `SEARCH`/`BARCODE`, the per-entry `foods.attribution`, §1.1)
   renders on the food/log detail. The dedicated screen satisfies the license; the inline
   tag makes provenance legible where it matters (a user seeing whether a calorie count came
   from USDA or a crowdsourced entry — which ties to the `DataQualityTag` confirm, §6).

Copy is plain and factual, not marketing (the exercise-credits tone).

---

## CORE-Sync — Offline sync-status treatment (the load-bearing thread)

Offline-first is load-bearing (§9): a meal is logged in a restaurant with poor signal and
syncs later; the UI's job is to make that **legible** and trustworthy.

- **`SyncStatusPill` — reuse the Phase 2 state machine including `local`.** `local`
  ("Saved on device", neutral `text.secondary` + device glyph) → `pending` ("Saved · will
  sync") → `syncing` ("Syncing…", cyan) → `synced` ("Synced", growth + check) / `failed`
  ("Sync failed · retry", danger + retry). Every state carries a **text label** (non-color
  signal), never color alone. **Never growth-green until server-confirmed.**
- **Where it appears:** every `MealCard` and `FoodLogItemRow` (until synced), the water
  day-total, manual burns, custom-food rows, saved-meal rows. **Not** on read-only catalog
  content (`FoodSearchRow`/barcode results — a server mirror, not the user's unsynced
  writes).
- **Save is never blocked on network.** Every log (food, meal, water, burn) saves to local
  SQLite first and returns the user to Today; the RPC is a background reconcile. This is the
  copy-level promise too (the Today offline banner and the empty-state copy say the log is
  safe offline, and the pill proves it live).
- **Idempotency is invisible but designed:** two grains for meals (meal `id` + per-item
  `id`), every write `ON CONFLICT (id) DO UPDATE`, item removal as explicit `deleted_at`
  tombstone (never omission) — the gate's "one synced copy of my breakfast" holds no matter
  how flaky sync retries (§9, `SAVE §2.1`).
- **Optimistic-then-reconciled overlap advisory:** the CORE-11 overlap check is computed
  on-device offline against the local timeline and reconciled with the RPC's
  `overlap_advisory` on sync (the same seam as the Phase 1/2 optimistic PR badges) — flagged
  for `mobile-builder`/`backend-builder` alignment so the client-side and server-side
  overlap results can't visibly diverge.

---

## Contrast — which text token at which size (READ THIS: the recurring AA failure, do not reintroduce)

This project has shipped the **same `text.tertiary`-at-small-size AA failure twice** (Phase
1, then Phase 2). It must not happen a third time in Module B, which is dense with small
metadata (source tags, serving lines, macro labels, data-quality captions). The rule,
explicit per token (values from `theme.ts`, ratios from `tokens.md §Contrast`):

- **`text.primary`** (graphite-50, ~16.9:1) — all metric-face values (kcal, grams, net,
  water total), headings, and any number the user reads at a glance. **All
  `MeridianBalance` / `MacroBreakdown` / `MetricStat` numbers are `text.primary`.**
- **`text.secondary`** (graphite-300, ~6.5:1 — clears **AA for normal text**) — the
  **default for all supporting text that carries information at small size**: `SourceTag`
  and `DataQualityTag` labels, `type.overline` provenance tags (**TRACKED · RUN**, etc.),
  serving lines, brand names, macro `PROTEIN/CARB/FAT` labels, meal-type labels, the
  "· relative date" meta, the water total caption. **When in doubt at ≤ 15px, use
  `secondary`, never `tertiary`.**
- **`text.tertiary`** (graphite-400, ~4.15:1 — clears AA **large/UI-only, ≥3:1**;
  **fails AA for normal-size text**) — used **only** for genuinely non-essential decoration
  at **large or bold sizes** (≥18.66px bold / ≥24px). It is **not** allowed on `type.overline`
  (11px), `type.caption` (12px), `type.label` (13px), or any `SourceTag`/`DataQualityTag`/
  serving/macro-label text. If a `SourceTag` or tag reads as "too loud" in `secondary`, the
  fix is a smaller/quieter *layout*, not a lower-contrast color.
- **Danger fills** (e.g. a destructive confirm on remove/delete) use `feedback.dangerSolid`
  with `text.onDanger` (white) — not `feedback.danger` under a white label (fails AA), the
  same split Phase 0 established.

---

## Handoff checklist for `mobile-builder`

- **Tokens only.** Every color/space/type/motion is a named `theme.ts` token. The only new
  token this phase is `color.energyBalance` (a semantic alias group, **no new hue** —
  `tokens.md §2.3`); use it only in `MeridianBalance` / `MacroBreakdown` / the water strip.
  Macros reuse `energyBalance.intake` (ember). No literals.
- **The signature is wired to specific call-sites — build it AND wire it (the Phase 2
  LiftStack lesson: a signature built as a component but never wired to data at the screen
  level is exactly what `anti-generic-ui-audit` caught).** `MeridianBalance` MUST render,
  fed by live RPC data, at **all** of these, not just exist as a component:
  - **`live`** → Food → **Today** hero (fed by `get_daily_energy_balance_v1`), re-settling
    on every meal/burn/water log.
  - **`static`** → each **History day row**, and the **post-log confirmation** echo.
  - **`empty`** → Today before any log; History empty state.
  - **`MacroBreakdown`** → Today (fed by `get_daily_macros_v1`) and the meal-save
    confirmation. If any of these ships without the signature actually bound to data, the
    phase is not done.
- **Numeric face everywhere numbers live** — kcal, macro grams, net, water volume, serving
  quantities, burn calories — all use the metric face (`fontVariation.metric`, tabular). It
  is the app's content, not optional.
- **`MeridianBalance`** is one component, `live`/`static`/`empty` variants; intake accretes
  warm, expenditure cool, origin settles at net; **no goal marker, no fill-to-100%**;
  reduced motion drops the accretion/settle easing but still updates masses/values; a11y
  text summary + non-color labels at every state. Reuse `MeridianMark` for the FAB glyph +
  empty seeds — no new glyphs.
- **`MacroBreakdown`** is **monochrome** (ember intake family), three horizontal bars,
  numbers in the metric face — **not** three colored donuts/rings (the anti-generic
  decision, `tokens.md §7`).
- **Catalog reads are ONLY the two RPCs + local cache** — `search_foods_v1` (paginated,
  cursor) and `resolve_barcode_v1` (point lookup). **The client MUST NOT ever `.select()`
  `foods`/`food_nutrients`/`food_servings` unranged** — the `max_rows = 1000` silent-
  truncation guard (§2.2). Custom foods and the user's own history read under normal RLS.
- **Save/edit map to the RPC contracts exactly:** meals → `save_food_log_entry_v1` (meal
  `id` + per-item `id` idempotency, upsert-present never delete-omitted, all macro snapshots
  **client-supplied** not server-recomputed — `SAVE §2.1/§2.3`); saved meals →
  `log_saved_meal_v1` (single-shot online, re-resolves current macros — `SAVEDMEAL §3`);
  water → `save_water_intake_v1`; manual burn → `save_manual_burn_v1` (negative
  `energy_kcal`; `estimated` behind E1 health consent; the overlap advisory is a **soft,
  post-save, dismissible banner**, never a blocker — `BURN §3.3`). A removed item is an
  explicit `deleted_at` in the payload.
- **CORE-11 provenance is legible:** the Today expenditure breakdown renders every
  `BALANCE.expenditure_events[]` row **once**, tagged TRACKED·RUN / TRACKED·LIFT / MANUAL
  (non-color tags), tracked rows tapping through to their source event. Nothing is double-
  counted; the design surfaces the reconciliation, it doesn't compute it (the RPC does).
- **Barcode miss is never a dead end:** `BARCODE_NOT_FOUND` / offline miss → custom-food
  creation prefilling the scanned barcode (§CORE-07/§CORE-Custom), creatable offline.
- **Attribution ships in-app** (the Nutrition sources credits screen **and** per-food
  `SourceTag` + `attribution` string) — a §6/§12.1 gate item, not a doc-only line. **ODbL
  (Open Food Facts) copy is NOT the CC-BY-SA copy** — it states attribution **and**
  share-alike; USDA is public-domain-with-requested-citation.
- **Consent:** ordinary food/water/burn logging is **never** consent-gated (§12 decision 3).
  The **only** gates are the **E3 camera** sheet for the scanner (point of use) and the
  **E1 health** sheet for **estimated** manual burn. Graceful decline states are
  requirements, not polish.
- **Offline-first is load-bearing:** every log saves to local SQLite first and syncs
  idempotently; `SyncStatusPill` (with the `local` state) on every unsynced write; search
  and scan work offline against the bounded local cache; never block save on network; never
  report "saved"/"synced" on a partial or unconfirmed write.
- **Accessibility floor (not a tradeoff):** every control ≥ `touchTarget.min` (serving
  stepper, water presets, complete/log buttons sized generously); the `MeridianBalance` and
  macro bars carry non-color signals (labels + metric-face numbers); sync/data-quality/
  provenance each carry a non-color signal (label or glyph), never color alone; reduced
  motion honored on the origin settle + accretion; **contrast per the §Contrast rule above —
  `text.tertiary` never on small text.**

---

## Decisions (settled 2026-07-22, the four flagged questions resolved by the person 2026-07-22)

All calls below are settled — recorded (mirroring the Phase 1/2 pattern) so `design-reviewer`
and future work can tell a deliberate choice from a default. The first six were design calls
made here; **D1–D4 were the four flagged questions, resolved by the person 2026-07-22** (the
Today mockup was reviewed as an Artifact first — the `MeridianBalance` visual concept was
approved with no changes requested).

**Design calls (recorded so `design-reviewer` can tell a choice from a default):**

1. **The `MeridianBalance` as the nutrition signature — the energy origin made a working
   instrument.** Nutrition doesn't fit the Mile (distance) or Lift (rep) axis, so it takes
   the **third part of the mark: the origin** where the two axes meet. Food pushes it warm,
   burn pulls it cool, net is where it rests. Chosen over a macro ring (structurally wrong —
   implies a goal Phase 3 doesn't have) and over three colored macro donuts (the category's
   most-copied cliché). This is the most on-thesis possible read of the data and it makes
   CORE-11's cross-module win visible.
2. **No goal/target anywhere in the nutrition UI** — beam shows net **actuals**, water shows
   the running total, macros show grams, all with **no target marker** — because Phase 3 has
   no goal model (§12 decision 5). Stated in-copy so the absence reads as intentional (the
   Phase 2 "list not calendar" honesty move).
3. **Macros are monochrome horizontal bars** (ember intake family), not three colored
   rings/donuts — the deliberate anti-generic choice; the metric face carries the grams.
4. **CORE-11 overlap advisory is soft = a post-save, dismissible inline banner with a
   one-tap "Remove this burn" undo**, never a modal blocker, never auto-merge/suppress — the
   concrete realization of §12 decision 2. The burn is always saved first (the RPC returns
   the advisory in its success body).
5. **Food tab is day-first (Today | History)**, unlike the history-first Activity/Lift tabs
   — because nutrition is inherently a "today" surface. Deliberate, stated.
6. **Attribution lives both as a dedicated credits screen and inline per-food `SourceTag`**;
   ODbL (Open Food Facts) copy states attribution **and** share-alike (distinct from CC-BY-SA
   and from USDA public-domain), per the actual license.

**Resolved by the person 2026-07-22 (were the flagged open questions):**

- **D1 — Food tab name = "Food"** (not "Fuel"), as recommended — plainspoken and literal,
  consistent with "Activity"/"Lift." (Five bottom tabs is the practical ceiling; the future
  Home dashboard is the pressure valve, noted, not built.)
- **D2 — Water presets = 250 / 500 / 750 ml (fl-oz equivalents on imperial) + a Custom
  entry**, as designed, one-tap-immediate. No hydration goal in Phase 3 (a future daily
  goal is the obvious Phase-4+ extension when the goal model lands; flagged, not built).
- **D3 — Offline saved-meal logging = expand-with-cached-macros immediately, sync/reconcile
  later — NOT blocked until online.** A saved-meal log is offline-first like every other log
  in the app: on "Log it" offline, the meal expands into local `food_log_items` using each
  item's last-known/cached macros and saves via `save_food_log_entry_v1` (the online path
  still uses `log_saved_meal_v1` for authoritative current-macro resolution). The narrow honest
  exception — an item never yet resolved on this device (no cached macros to expand) — shows a
  one-line "connect once to log this meal" note rather than fabricating a figure. Fully
  specified in §CORE-10 "Log-time behavior — online vs. offline."
- **D4 — Low-`data_quality` foods = soft caution + editable, never blocks logging**, as
  designed (§6/§CORE-06) — no extra mandatory confirmation step. The `low` `DataQualityTag`
  caution + prominent, inline-editable resolved numbers are the guardrail; the user is never
  stopped, keeping the fastest-path flow unblocked (the speed-over-friction call).

**Coordination note for `mobile-builder`/`backend-builder` (not a person-decision):** the
CORE-11 overlap advisory is **optimistic-then-reconciled** — computed on-device offline
against the local timeline and reconciled with the RPC's `overlap_advisory` on sync (the
same seam as the Phase 1/2 optimistic PR badges). Keep the client-side and server-side
overlap results from visibly diverging; the RPC supports it (`BURN §3.3`) but doesn't itself
state the client pre-computes it.
