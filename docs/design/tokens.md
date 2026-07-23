# MileLift — Design Tokens & Foundations

Status: **Phase 0 design system, v1.** This is the reasoning-and-roles companion
to `docs/design/theme.ts`, which holds the actual values `mobile-builder`
imports. Where they ever disagree, `theme.ts` is the source of truth and this
doc is wrong and should be fixed.

Downstream: `mobile-builder` (implements against `theme.ts`), `design-reviewer`
(checks this is an original system, not a competitor reproduction — see
**Originalization notes** at the end, which flags what to scrutinize hardest).

---

## 0. The one idea the whole system is built on

MileLift's name states its own differentiator: **"Mile" + "Lift" = the hybrid
athlete** — the person who *both* runs/rides *and* lifts, and who today is
forced to keep those two halves of their training in separate apps that don't
talk to each other. Every other fitness app is either an endurance app or a
strength app wearing a "does everything" label. MileLift's reason to exist is
that it refuses to pick a side.

So the design refuses to pick a side too. The entire visual language is a
**warm ↔ cool duality**:

- **The Mile** — endurance. Warm. Dawn light, horizon, distance-over-time, the
  sustained aerobic effort. Expressed **horizontally**.
- **The Lift** — strength. Cool. Iron, gravity, load, the explosive anaerobic
  effort. Expressed **vertically**.
- **The foundation** — cold graphite, the shared iron both sit on.

This is the test every token below had to pass: *would I have produced this same
value for a generic "fitness app" with no other information?* If yes, it was
revised. The duality is what makes the answers specific to *this* app.

---

## 1. Voice & tone (decided once, holds every screen)

**A precise, plainspoken coach who respects your time.** Not a hype man.

- **Clinical-leaning but not cold.** State what a thing does and why, in the
  user's terms. "Location records your route while an activity is recording, and
  only then." — not "Enable location for the best experience!"
- **Active voice, matched pairs.** A button says `Allow health access`; the
  resulting confirmation says `Health access on`, never a mismatched generic
  toast.
- **No emoji doing the emotional work the words didn't.** If a line needs a 💪
  to land, the line is rewritten. (This is the single most common generic-copy
  tell in this category — the standards name it explicitly.)
- **Name things by what the user controls, not by system internals.** "Turn off
  in Settings," not "revoke OAuth scope."
- **Reassure by being specific about limits.** Trust is a stated product goal
  (the spec's whole "Correct" thesis is about eroded trust). Every consent
  prompt says plainly what MileLift does *not* do.

---

## 2. Color — roles, not just hex

The spec derived its palette from the five source apps and maps each color to a
*communicative role*. We honor the **roles** and derive MileLift's **own values**
(see `theme.ts` for the full scales; below is the role each family carries and
what it *means* in the product).

| Family | Token role | What it MEANS in MileLift | Derived-from role (spec) | How we kept it original |
| --- | --- | --- | --- | --- |
| **Graphite** | `bg.*`, `border.*`, `text.*` | The iron foundation both disciplines sit on; all structure and text | Navy / platform foundation | Blue-tinted cold graphite (steel/pre-dawn), not a corporate navy |
| **Ember** `#F5871F` | `accent.primary` | **Activity & energy**; the Mile; every primary CTA | Strava orange → activity/energy | Pulled to golden amber (dawn, hue ~32°), away from Strava's red-orange (~17°); always paired with the cool axis |
| **Steel Cyan** `#38A9C9` | `accent.data` | **Tracking, accuracy, telemetry**; the trust color | MFP+Jefit blue → trust/data | Instrument-panel cyan/teal, not a royal app-blue |
| **Voltage** `#7C5CFF` | `accent.ai` | **AI & intensity**; smart-system moments | Fitbod red → AI/intensity | Re-cast entirely as electric violet (furthest from the competitor; frees a clean functional red) |
| **Growth** `#2FC978` | `accent.growth` / `feedback.success` | **Coaching, growth, progress, "done/synced/granted"** | Caliber green/lime → coaching/growth | Fresh emerald, not neon lime; doubles as functional success |

**Functional-only** (not brand roles): `feedback.danger` `#EF4E3A` (a true red,
kept distinct from Voltage-violet so "error" never reads as "AI"),
`feedback.warning` `#F5B830` gold, `feedback.info` reuses cyan.

### 2.1 `color.map` — route rendering (added Phase 1, CORE-02)
The activity detail map (`activity_routes.simplified_path`) needs named colors a
map component can reference without hardcoding literals (production-standards: no
magic values in a component). It is a **semantic alias group, not a new hue** —
this was a deliberate hold-the-line decision against the design-reviewer "original,
not generic" bar:

| Token | Value | Meaning |
| --- | --- | --- |
| `map.route` | `accent.primary` (ember) | The route line. A recorded route **is the Mile drawn on the earth** — so it is literally the activity/energy color, not a new "map blue." This is the single most on-thesis reuse in the system. |
| `map.routeCasing` | graphite-950 @55% (dark) / white @70% (light) | A contrast casing stroked under the ember line so it stays legible over any map-tile color. Not a brand color — a legibility device. |
| `map.startMarker` | `accent.growth` | Start of the activity = "go"; growth already carries the go/confirmed meaning. |
| `map.finishMarker` | `accent.primary` (ember) | Finish = the Meridian origin, rendered ember. |

**Why no PR-celebration color was added.** The task explicitly floated a
"PR-celebration accent" as a candidate token. We deliberately did **not** add one.
A new celebratory hue (the reflex is medal-gold) would (a) reintroduce the medal/
trophy/confetti cliché the anti-generic ledger (§7) exists to avoid, and (b)
overload `feedback.warning` gold with a second meaning. A personal record in
MileLift is celebrated through the **existing** language instead — the Meridian
Mile axis extends past its previous mark and the origin flares in `accent.primary`
(ember = peak effort/energy), with a `feedback.success` (growth) "New best" delta
tag. Ember + growth + the signature carry it; the palette already serves this, so
no token was added (see screens-phase-1.md §PR surfaces).

**Map tile style.** The MapView uses a **dark, desaturated graphite tile style**
(a custom style JSON), not the platform default colorful map — so the map screen
stays inside the brand and the ember route is the one saturated thing on it. This
is a design decision, not a default map drop-in (see screens-phase-1.md §CORE-02).

### 2.2 `color.restTimer` — rest-timer countdown (added Phase 2, CORE-12)
The between-sets rest timer (screens-phase-2.md §CORE-12) is one of Module C's
defining features vs. competitors, so it gets a **first-class, named treatment**
— but, exactly like `color.map`, it is a **semantic alias group, not a new hue**.
It exists so the `RestTimer` component references a named *state-role* rather than
a raw palette value, and so the running/ending/done meanings are decided here once
(not guessed per build — e.g. whether "ending" is warning-gold or danger-red).

| Token | Value | Meaning |
| --- | --- | --- |
| `restTimer.track` | `bg.inset` (graphite) | The depleting countdown track well — a neutral ground, not a brand color. |
| `restTimer.fill` | `accent.data` (cyan) | The running countdown. Rest is the *recovery* moment inside the Lift context; cyan is the trust/telemetry/recovery color, and it is the Meridian's Lift-axis hue — the timer reads as the Lift axis catching its breath. |
| `restTimer.ending` | `feedback.warning` (gold) | The final ~10s. Gold = "attention, almost" — never danger-red (nothing is *wrong* about rest ending). |
| `restTimer.done` | `accent.growth` (green) | Rest complete — the same "go / done / confirmed" meaning growth already carries everywhere. |

**Why this is not overreach.** No new color family is introduced — all four map to
existing roles (data / warning / growth / inset). It is added, over referencing
those roles inline, for the identical reason `color.map` was: a defining component
whose state-to-role mapping is a real design decision worth naming and freezing, so
`design-reviewer` can see the ending state was *chosen* gold, not defaulted to red.
The countdown itself carries a non-color signal at every state (the numeric readout
in the metric face + a text label "Rest" / "Rest done"), never color alone.

### 2.3 `color.energyBalance` — the daily energy ledger (added Phase 3, CORE-08/11)
The nutrition module's signature surface (screens-phase-3.md §0/§CORE-08) is the
**MeridianBalance**: the Meridian's *origin* — the point where the horizontal Mile
axis and the vertical Lift axis meet — made a working instrument, the way Phase 1
made the horizontal axis live (`MeridianTrace`) and Phase 2 made the vertical axis
live (`LiftStack`). It gets a **first-class, named treatment** — but, exactly like
`color.map` and `color.restTimer`, it is a **semantic alias group, not a new hue**.
It exists so the component references named *energy-role* values rather than raw
palette entries, and so the in / out / net mapping is decided here once.

| Token | Value | Meaning |
| --- | --- | --- |
| `energyBalance.track` | `bg.inset` (graphite) | The beam's neutral ground — not a brand color. |
| `energyBalance.intake` | `accent.primary` (ember) | **Energy in (food).** Ember's role is "activity & energy"; food is energy taken in, so intake is literally the energy color — the single most on-thesis reuse here, the nutrition counterpart to "a route IS ember because it's the Mile drawn on the earth" (§2.1). Also the fill of the macro-composition bars: macros *are* the intake, itemized. |
| `energyBalance.expenditure` | `accent.data` (cyan) | **Measured energy out (burn).** Cyan is trust/telemetry/accuracy; a calories-out figure is a measured/estimated quantity, and the day's biggest expenditure contributor (a lift) is already cyan. The Meridian's warm↔cool duality maps onto energy's own duality: **in (warm) ↔ out (cool), meeting at the origin.** |
| `energyBalance.origin` | `text.primary` | **The net pivot** = the Meridian origin ("where you are right now"). Where it rests between the warm and cool masses is the day's net. |
| `energyBalance.water` | `cyan[400]` | The day's hydration accretion (CORE-09). Cyan (fluid/telemetry), deliberately **not** on the ember/cyan *energy* beam — water carries no `energy_kcal` (§1.7), so it must read as a separate quantity, never as intake or burn. |

**Why no surplus/deficit color, and no goal marker.** The reflex is green-surplus /
red-deficit and a goal line on the beam. We deliberately add **neither**: (a) net
sign is carried by the **signed metric-face number** + which side the origin rests,
never a value-laden hue — a surplus isn't "bad" and a deficit isn't "good" without a
goal to judge against; (b) Phase 3 has **no goal/target model** (architecture §12
decision 5), so a target marker on the beam would imply a "remaining vs. goal"
mechanic that does not exist — the same honesty as Phase 2's program builder being a
list, not a calendar, because there is no scheduler yet. The beam shows **net
actuals**, and says so.

**Why this is not overreach.** No new color family — all five roles map to existing
tokens (inset / ember / cyan / text.primary). It is added, over referencing those
roles inline, for the identical reason `color.map` and `color.restTimer` were: a
defining component whose role mapping is a real, freeze-worthy decision, so
`design-reviewer` can see intake was *chosen* ember, not defaulted to green. The
balance carries non-color signals at every state (the signed net in the metric face,
"in" / "out" / "net" labels, and per-line provenance tags in the expenditure
breakdown), never color alone.

### Meaning-level color rules (so color is never decorative)
- **Ember is spent, not sprinkled.** It marks the one primary action on a screen
  and activity/energy data. If two things on a screen are ember, one of them is
  wrong.
- **Voltage is rare.** Near-zero use in Phase 0 (there's almost no AI surface
  yet). It's defined now so downstream AI features inherit one consistent signal
  instead of each inventing "the AI color."
- **Never color-only.** Success/completion always carries a glyph (check) as well
  as Growth-green; this is a hard accessibility rule (mobile-architecture: don't
  rely on color-only distinctions), not a preference.

### Theme
Dark is the default and the primary Phase 0 surface (the spec's "dark, serious
base"). A full light theme with the same semantic keys exists in `theme.ts` for
later daylight/outdoor screens (sunlight contrast, per
mobile-architecture-standards). Phase 0 screens are specified in dark.

### Contrast (the floor, verified — measured, not assumed)
- `text.primary` (graphite-50) on `bg.canvas` (graphite-950): **16.9:1** — AAA.
- `text.secondary` (graphite-300) on canvas: **6.5:1** — AA (and AAA large).
- `text.tertiary` (graphite-400): **4.15:1** — clears AA **large/UI only** (≥3:1);
  **never** normal-size body text. Metadata, captions ≥18.66px bold or ≥24px only.
- Ember fill + graphite-950 ink: **7.7:1**; Growth fill + graphite-950 ink:
  **8.9:1** — both clear AA for button labels.
- `feedback.danger` (danger-500) as **text/icon/border** on dark: **5.3:1** (AA).
  Solid **danger fills** carrying white labels use `feedback.dangerSolid`
  (danger-600): **4.8:1** — because white-on-danger-500 is only 3.6:1 and would
  fail AA for a normal-size destructive-button label. This split is why there are
  two danger tokens.
- Focus ring is **cyan**, deliberately not the ember CTA color, so a focused
  primary button shows a ring distinct from its own fill.

---

## 3. Typography — three faces with three jobs

Numbers are the actual content of a fitness app, so the numeric face is a
first-class decision here, not a font-family afterthought.

| Face | Family | Job | Why this, not the default |
| --- | --- | --- | --- |
| **Display** | Archivo (Expanded width axis) | Hero/brand headlines, section titles | Structural, wide, stamped-metal / stadium-signage feel — carries the "serious training equipment" register. Default would be Inter/SF/Poppins everywhere. |
| **Body/UI** | Inter | All running text, labels, controls | The legibility workhorse; scales cleanly with Dynamic Type. The floor, done well. |
| **Metric/Data** | JetBrains Mono | Reps, weight, pace, time, distance, units | **Tabular figures + slashed zero** — instrument/stopwatch/plate-stamp register. Columns of numbers align; a `0` never reads as `O`. This is the app's data content, treated as design. |

All three are open-source and load via `@expo-google-fonts/{archivo,inter,jetbrains-mono}`.
Archivo's Expanded width is applied via `fontVariation.display` (`'wdth' 125`);
the metric face applies `fontVariation.metric` (`tabular-nums`).

Full scale (sizes, line heights, tracking) is in `theme.ts` under `type`. The
scale is intentionally compact — display used with restraint, one metric ramp
for data, body for everything else.

**Phase 0 already uses the metric face** — profile weight/height/units, the
onboarding balance ratio — so the numeric identity is established from the first
screen a user sees, not bolted on when logging arrives.

---

## 4. Spacing, shape, elevation

- **Spacing:** 8pt base with 4pt half-steps, named (`space.xs`…`space.giant`).
  Screen edge gutter is `screen.edge` (16pt). Reference by name; a raw `20` in a
  component is a bug.
- **Shape:** radii are assigned **per component role** (`radius.sm` inputs/chips,
  `radius.md` buttons, `radius.lg` cards, `radius.xl` sheets, `radius.pill`
  toggles) — deliberately *not* one uniform corner on everything, which is the
  "every content type is the same rounded box" generic tell.
- **Elevation:** on dark, depth is carried mainly by **surface lightness**
  (`bg.surface` → `bg.raised`), with shadow reserved for genuinely floating
  things (sheets, toasts). Shadow tokens exist mostly for the light theme.

---

## 5. Motion

Small, purposeful, and **reduced-motion-aware**. Durations/easings live in
`theme.ts` (`duration`, `easing`, `spring`).

- `fast` (120ms) press feedback, `base` (200ms) most transitions, `slow` (320ms)
  screen/sheet, `deliberate` (480ms) the signature Meridian draw.
- **`prefers-reduced-motion` is honored everywhere.** The Meridian's draw-on
  animation renders **complete and static** (a crossfade, no stroke animation)
  when reduced motion is set. No parallax, no auto-playing motion that the user
  didn't initiate.

---

## 6. The signature element — "The Meridian"

The one thing MileLift is meant to be visually remembered by, and the place we
spend our boldness (everything else stays quiet around it).

**What it is:** a two-stroke axis mark. A **horizontal baseline** (the Mile axis
— distance, endurance, time) meets a **vertical riser** (the Lift axis — load,
gravity, strength) at a single **origin point** — "where you are right now." The
horizontal stroke is warm (ember), the vertical is cool (cyan), and the origin
is exactly where warm meets cool. It literally draws the app's thesis.

It is **not** a circular progress ring (the category's most-copied cliché), not
a flame, not a pulse line — it's derived from *this* app's specific reason to
exist, and no generic fitness brief would produce it.

**How it earns its keep across Phase 0 (it's not just a logo):**
- **Logo / wordmark lockup** — the origin glyph precedes the wordmark.
- **Onboarding progress indicator** — replaces the generic dots. Advancing
  through onboarding draws the Mile axis; finishing raises the Lift axis, so the
  user *builds* the hybrid mark and the thesis is stated by the interaction
  itself. (Detailed in the screen spec.)
- **Section header motif** — a small origin glyph anchors profile sections and
  each consent prompt header.
- **Empty/first-run states** — the un-built Meridian (origin only, axes faint)
  is the visual for "your history starts here."

Motion: the axes draw from the origin outward over `duration.deliberate`; the
origin does a small `spring.settle`. Under reduced motion it's simply present,
fully drawn.

---

## 7. What we deliberately did NOT do (anti-generic ledger)

Named so `design-reviewer` can tell a deliberate choice from a default:

- **No circular activity/progress ring** as the signature — replaced by the
  Meridian.
- **No flame streak icon** — not needed in Phase 0, and if streaks arrive they
  go through the Meridian/Growth language, not a borrowed Duolingo flame.
- **No stock-athlete-mid-jump hero** on onboarding/auth — the brand mark and
  type carry it; a dark graphite field, not a gradient photo overlay.
- **No untouched component-library defaults** — no Material indigo, no iOS
  system blue as "the color"; ember/cyan/graphite are a made decision.
- **No goal-selection card grid + progress dots + permissions carousel** in
  onboarding — the three most-copied onboarding patterns, all replaced (see
  screen spec).
- **No uniform rounded-shadow box for every content type** — radii and elevation
  are role-assigned.
- **No calorie/macro progress ring, and no three arbitrarily-colored macro
  rings/donuts** (Phase 3, the nutrition category's single most-copied cliché) —
  replaced by the **MeridianBalance** (calories in/out/net as the origin balancing
  between warm intake and cool expenditure) and a **monochrome horizontal
  macro-distribution breakdown** (P/C/F length-encoded in the ember intake family,
  the numbers doing the work in the metric face — a distribution is horizontal bars,
  the same rule Phase 2 set for muscle volume). See screens-phase-3.md §0.

---

## 8. Originalization notes — where competitor association was hardest
### (read this first, `design-reviewer`)

Being honest about the risky spots so they get the most scrutiny:

1. **Ember / the activity color is the hardest to originalize, by far.** Strava
   effectively owns "fitness orange," so *any* warm accent used for
   activity/energy/CTA in a fitness app carries some echo — the association is
   structural, not just chromatic. Our mitigations: (a) hue shifted to golden
   amber (~32°) with a stated dawn/first-mile rationale, meaningfully off
   Strava's saturated red-orange (~17°); (b) it never appears alone as "the
   brand color" — it's always half of a warm↔cool duality that Strava has no
   equivalent of. **This is the token to challenge hardest.** If it still reads
   as Strava-derivative in context, the fallback is to push further toward
   amber-gold (`ember.400`/gold family) as primary.
2. **Growth-green doubling as success is a mild convergence.** Green = success is
   near-universal, so this reads as "conventional" rather than "Caliber-derived"
   — low risk, but noting it's a convention we adopted, not an independent
   invention.
3. **Voltage/AI = violet was re-cast, not derived.** We deliberately did **not**
   originalize Fitbod-red-in-place; we changed the hue family entirely (red →
   violet). This is a defensible move *away* from the competitor, but it is a
   documented deviation from the spec's literal "red" — flagging it so it reads
   as intentional, not as us missing the mapping.
4. **Cyan and Graphite are low-risk** — instrument-cyan and cold-graphite are far
   enough from MFP/Jefit royal-blue and generic navy that competitor association
   isn't a live concern.
