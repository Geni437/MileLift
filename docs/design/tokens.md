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
